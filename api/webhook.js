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

    // ── Phone number ──
    const callerPhone =
      metadata?.phone_call?.external_number ||
      metadata?.twilio?.from;

    const callDuration = metadata?.call_duration_secs || 0;

    if (!callerPhone) {
      return res.status(400).json({ error: 'No phone number found' });
    }

    // ── Data Collection points from ElevenLabs Analysis ──
    const dataCollection = analysis?.data_collection || {};
    const contactName   = dataCollection?.contact_name?.value   || '';
    const contactEmail  = dataCollection?.contact_email?.value  || '';
    const businessName  = dataCollection?.business_name?.value  || '';
    const businessType  = dataCollection?.business_type?.value  || '';
    const demoScheduled = dataCollection?.demo_scheduled?.value === true || 
                          String(dataCollection?.demo_scheduled?.value).toLowerCase() === 'true';
    const infoEmailSent = dataCollection?.information_email_sent?.value === true || 
                          String(dataCollection?.information_email_sent?.value).toLowerCase() === 'true';

    // ── Evaluation Criteria results ──
    const evaluations   = analysis?.evaluation_criteria || {};
    const leadQualified = evaluations?.Lead_Qualified?.result === 'success' ||
                          evaluations?.lead_qualified?.result === 'success';
    const callEndedGracefully = evaluations?.Call_Ended_Gracefully?.result === 'success' ||
                                evaluations?.call_ended_gracefully?.result === 'success';

    // ── Split contact_name into first/last ──
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

    // Build contact properties to update
    const contactProperties = {
      phone: callerPhone,
      ...(firstName && { firstname: firstName }),
      ...(lastName  && { lastname: lastName }),
      ...(contactEmail  && { email: contactEmail }),
      ...(businessName  && { business_name: businessName }),
      ...(businessType  && { business_type: businessType }),
      ...(demoScheduled !== undefined && { demo_scheduled: demoScheduled }),
      ...(infoEmailSent !== undefined && { information_email_sent: infoEmailSent }),
      ...(leadQualified !== undefined && { lead_qualified: leadQualified }),
    };

    if (searchRes.data.results.length > 0) {
      // Contact exists → update their properties
      contactId = searchRes.data.results[0].id;
      await axios.patch(
        `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`,
        { properties: contactProperties },
        { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } }
      );
    } else {
      // Contact doesn't exist → create with all properties
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
        .map(turn => `${turn.role === 'agent' ? 'AI Assistant' : 'Caller'}: ${turn.message}`)
        .join('\n');
    }

    // ── Build evaluation summary ──
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
