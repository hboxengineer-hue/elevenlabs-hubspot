const axios = require('axios');
const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const webhookData = req.body.data;
    if (!webhookData) {
      return res.status(400).json({ error: 'Missing payload data object' });
    }

    const { transcript, metadata, analysis } = webhookData;

    // ── Phone number (correct path from real payload) ──
    const callerPhone = webhookData.user_id ||
      metadata?.phone_call?.external_number;

    const callDuration = metadata?.call_duration_secs || 0;

    if (!callerPhone) {
      return res.status(400).json({ error: 'No phone number found' });
    }

    // ── Data Collection (correct key: data_collection_results) ──
    const dataCollection = analysis?.data_collection_results || {};
    const contactName  = dataCollection?.contact_name?.value  || '';
    const contactEmail = dataCollection?.contact_email?.value || '';
    const businessName = dataCollection?.business_name?.value || '';
    const businessType = dataCollection?.business_type?.value || '';
    const demoScheduled = dataCollection?.demo_scheduled?.value === true ||
                          String(dataCollection?.demo_scheduled?.value).toLowerCase() === 'true';
    const infoEmailSent = dataCollection?.information_email_sent?.value === true ||
                          String(dataCollection?.information_email_sent?.value).toLowerCase() === 'true';

    // ── Evaluation Criteria (correct key: evaluation_criteria_results) ──
    const evaluations = analysis?.evaluation_criteria_results || {};
    const leadQualified = evaluations?.lead_qualified?.result === 'success';
    const callEndedGracefully = evaluations?.call_ended_gracefully?.result === 'success';

    // ── Split name into first/last ──
    const nameParts = contactName.trim().split(' ');
    const firstName = nameParts[0] || 'Unknown';
    const lastName  = nameParts.slice(1).join(' ') || 'Caller';

    // ── Find or create contact in HubSpot ──
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

    const contactProperties = {
      phone: callerPhone,
      ...(firstName    && { firstname: firstName }),
      ...(lastName     && { lastname: lastName }),
      ...(contactEmail && { email: contactEmail }),
      ...(businessName && { business_name: businessName }),
      ...(businessType && { business_type: businessType }),
      demo_scheduled: demoScheduled,
      information_email_sent: infoEmailSent,
      lead_qualified: leadQualified,
    };

    if (searchRes.data.results.length > 0) {
      contactId = searchRes.data.results[0].id;
      await axios.patch(
        `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`,
        { properties: contactProperties },
        { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } }
      );
    } else {
      const createRes = await axios.post(
        'https://api.hubapi.com/crm/v3/objects/contacts',
        { properties: contactProperties },
        { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } }
      );
      contactId = createRes.data.id;
    }

    // ── Format transcript ──
    let readableTranscript = 'No transcript recorded.';
    if (Array.isArray(transcript)) {
      readableTranscript = transcript
        .filter(turn => turn.message && turn.message !== '...')
        .map(turn => `${turn.role === 'agent' ? 'AI Assistant' : 'Caller'}: ${turn.message}`)
        .join('\n');
    }

    // ── Evaluation summary ──
    const evalSummary = [
      `✅ Lead Qualified:         ${leadQualified ? 'Yes' : 'No'}`,
      `📅 Demo Scheduled:         ${demoScheduled ? 'Yes' : 'No'}`,
      `📧 Info Email Opted In:    ${infoEmailSent ? 'Yes' : 'No'}`,
      `📞 Call Ended Gracefully:  ${callEndedGracefully ? 'Yes' : 'No'}`,
    ].join('\n');

    // ── Log Note on contact ──
    await axios.post(
      'https://api.hubapi.com/crm/v3/objects/notes',
      {
        properties: {
          hs_note_body: [
            `📞 ElevenLabs AI Call`,
            `Duration: ${callDuration} seconds`,
            `Contact: ${contactName || 'Unknown'}`,
            `Business: ${businessName || 'Unknown'} (${businessType || 'Unknown'})`,
            `Email: ${contactEmail || 'Not provided'}`,
            ``,
            `── Evaluation Results ──`,
            evalSummary,
            ``,
            `── Transcript ──`,
            readableTranscript
          ].join('\n'),
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
    console.error('Webhook error:', error.response?.data || error.message);
    return res.status(500).json({ error: 'Something went wrong' });
  }
};
