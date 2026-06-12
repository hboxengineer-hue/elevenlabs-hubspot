const axios = require('axios');

const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;

module.exports = async function handler(req, res) {

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // 1. ElevenLabs wraps call properties inside the 'data' object
    const webhookData = req.body.data;
    if (!webhookData) {
      return res.status(400).json({ error: 'Missing payload data object' });
    }

    const { transcript, metadata } = webhookData;
    
    // 2. Map the correct path for telephony metadata
    const callerPhone = metadata?.phone_call?.external_number || metadata?.twilio?.from;
    const callDuration = metadata?.call_duration_secs || 0;

    if (!callerPhone) {
      return res.status(400).json({ error: 'No phone number found in payload structure' });
    }

    // ── Find contact in HubSpot ──
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

    // 3. Format the transcript array into a single clean string block
    let readableTranscript = 'No transcript text content recorded.';
    if (Array.isArray(transcript)) {
      readableTranscript = transcript
        .map(turn => `${turn.role === 'agent' ? 'AI Assistant' : 'Caller'}: ${turn.message}`)
        .join('\n');
    }

    // ── Log transcript as Note on contact ──
    await axios.post(
      'https://api.hubapi.com/crm/v3/objects/notes',
      {
        properties: {
          hs_note_body: `📞 ElevenLabs Voice Agent Call\nDuration: ${callDuration} seconds\n\nTranscript:\n${readableTranscript}`,
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
    console.error('Error processing webhook:', error.response?.data || error.message);
    return res.status(500).json({ error: 'Something went wrong' });
  }
}
