const axios = require('axios');

const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;

export default async function handler(req, res) {

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { transcript, metadata, call_duration } = req.body;
    const callerPhone = metadata?.twilio?.from;

    if (!callerPhone) {
      return res.status(400).json({ error: 'No phone number found' });
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

    // ── Log transcript as Note on contact ──
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
