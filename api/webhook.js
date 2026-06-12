const axios = require('axios');

const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN; // pulled from Vercel settings

export default async function handler(req, res) {

  // Only accept POST requests from ElevenLabs
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { transcript, metadata, call_duration } = req.body;

    // Get the caller's phone number (comes from Twilio via ElevenLabs)
    const callerPhone = metadata?.twilio?.from;

    if (!callerPhone) {
      return res.status(400).json({ error: 'No phone number found' });
    }

    // ── STEP 1: Find contact in HubSpot by phone number ──
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
      // Contact already exists → use their ID
      contactId = searchRes.data.results[0].id;

    } else {
      // Contact doesn't exist → create them automatically
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

    // ── STEP 2: Log the call + transcript on that contact ──
    await axios.post(
      'https://api.hubapi.com/engagements/v1/engagements',
      {
        engagement: {
          type: 'CALL',
          active: false,
          timestamp: Date.now()
        },
        associations: {
          contactIds: [contactId]
        },
        metadata: {
          body: transcript,
          durationMilliseconds: call_duration * 1000,
          status: 'COMPLETED',
          direction: 'OUTBOUND'
        }
      },
      { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } }
    );

    return res.status(200).json({ success: true });

  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
    return res.status(500).json({ error: 'Something went wrong' });
  }
}
