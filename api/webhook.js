const axios = require('axios');
const crypto = require('crypto');

const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
const ELEVENLABS_SECRET = process.env.ELEVENLABS_SECRET;

export default async function handler(req, res) {

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {

    // ── STEP 1: Verify HMAC signature from ElevenLabs ──
    const signature = req.headers['elevenlabs-signature'];

    if (!signature) {
      return res.status(401).json({ error: 'No signature found' });
    }

    // Extract timestamp and hash from signature header
    const parts = signature.split(',');
    const timestamp = parts[0].replace('t=', '');
    const receivedHash = parts[1].replace('v0=', '');

    // Recreate the expected hash
    const payload = `${timestamp}.${JSON.stringify(req.body)}`;
    const expectedHash = crypto
      .createHmac('sha256', ELEVENLABS_SECRET)
      .update(payload)
      .digest('hex');

    // Compare — reject if they don't match
    if (receivedHash !== expectedHash) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    // ── STEP 2: Get data from ElevenLabs ──
    const { transcript, metadata, call_duration } = req.body;
    const callerPhone = metadata?.twilio?.from;

    if (!callerPhone) {
      return res.status(400).json({ error: 'No phone number found' });
    }

    // ── STEP 3: Find contact in HubSpot by phone number ──
    const searchRes = await axios.post(
      'https://api.hubapi.com/crm/v3/objects/contacts/search',
      {
        filterGroups: [{
          filters: [{
            propertyName: 'phone',
            operator: 'EQ',
            value: callerPhone
          }]
        }]
      },
      { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } }
    );

    let contactId;

    if (searchRes.data.results.length > 0) {
      contactId = searchRes.data.results[0].id;
    } else {
      // Create new contact if doesn't exist
      const createRes = await axios.post(
        'https://api.hubapi.com/crm/v3/objects/contacts',
        {
          properties: {
            phone: callerPhone,
            firstname: 'Unknown',
            lastname: 'Caller'
          }
        },
        { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } }
      );
      contactId = createRes.data.id;
    }

    // ── STEP 4: Log transcript as a Note on the contact ──
    await axios.post(
      'https://api.hubapi.com/crm/v3/objects/notes',
      {
        properties: {
          hs_note_body: `📞 ElevenLabs Call\nDuration: ${call_duration}s\n\nTranscript:\n${transcript}`,
          hs_timestamp: Date.now().toString()
        },
        associations: [{
          to: { id: contactId },
          types: [{
            associationCategory: 'HUBSPOT_DEFINED',
            associationTypeId: 202
          }]
        }]
      },
      { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } }
    );

    return res.status(200).json({ success: true });

  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
    return res.status(500).json({ error: 'Something went wrong' });
  }
}
