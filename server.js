// server.js
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// TODO: Set your GupShup Partner API key in .env
const PARTNER_API_KEY = process.env.GUPSHUP_PARTNER_API_KEY;
const PARTNER_API_BASE = 'https://api.gupshup.io/partner/v1';

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// ================================
// UTILITY FUNCTIONS
// ================================

function validatePhoneNumber(phone) {
  const cleanPhone = phone.replace(/\D/g, '');
  if (cleanPhone.length < 10 || cleanPhone.length > 15) return false;
  return cleanPhone;
}

function formatPhoneForGupShup(phone) {
  const cleanPhone = validatePhoneNumber(phone);
  if (!cleanPhone) throw new Error('Invalid phone number format. Use E.164 format (e.g., 917834811114)');
  return cleanPhone;
}

// GupShup Partner API: Create app for new client
async function createClientAppWithPartnerAPI({ company, tenant_id }) {
  const response = await axios.post(
    `${PARTNER_API_BASE}/apps`,
    {
      name: `${company}-WhatsApp`,
      description: `WhatsApp integration for ${company}`,
      webhook_url: `${process.env.BASE_URL || 'https://your-server.com'}/webhook/${tenant_id}`
    },
    {
      headers: {
        'Authorization': `Bearer ${PARTNER_API_KEY}`,
        'Content-Type': 'application/json'
      }
    }
  );
  return response.data;
}

// GupShup Partner API: Update app with phone number
async function updateAppPhoneNumberWithPartnerAPI(app_id, phone_number) {
  return axios.post(
    `${PARTNER_API_BASE}/apps/${app_id}/phone`,
    { phone_number },
    {
      headers: {
        'Authorization': `Bearer ${PARTNER_API_KEY}`,
        'Content-Type': 'application/json'
      }
    }
  );
}

// GupShup Partner API: Request new phone number
async function requestNewPhoneNumberWithPartnerAPI(app_id) {
  return axios.post(
    `${PARTNER_API_BASE}/apps/${app_id}/phone/new`,
    {},
    {
      headers: {
        'Authorization': `Bearer ${PARTNER_API_KEY}`,
        'Content-Type': 'application/json'
      }
    }
  );
}

// ================================
// BITRIX24 INSTALLATION & TENANT ONBOARDING
// ================================

// POST /bitrix24/install
// Fixed Bitrix24 Install Handler
// Flexible install handler that accepts both JSON and form data
app.post('/bitrix24/install', async (req, res) => {
  console.log('Bitrix24 install request headers:', req.headers);
  console.log('Bitrix24 install request body:', req.body);
  
  // Handle both JSON and form-encoded data
  let data = req.body;
  
  // If body is empty, try to parse raw body
  if (!data || Object.keys(data).length === 0) {
    try {
      const rawBody = JSON.stringify(req.body);
      data = JSON.parse(rawBody);
    } catch (e) {
      console.log('Could not parse as JSON, using form data');
    }
  }
  
  const { 
    DOMAIN, 
    AUTH_ID, 
    AUTH_EXPIRES, 
    REFRESH_ID, 
    member_id,
    APPLICATION_TOKEN 
  } = data;
  
  // Validate required fields
  if (!DOMAIN || !AUTH_ID || !REFRESH_ID) {
    return res.status(400).json({ 
      success: false, 
      error: 'Missing required fields: DOMAIN, AUTH_ID, REFRESH_ID' 
    });
  }
  
  const tenant_id = uuidv4();
  
  try {
    // 1. Save Bitrix24 install info
    await pool.query(
      'INSERT INTO tenants (id, bitrix_domain, bitrix_auth_id, bitrix_refresh_token) VALUES ($1, $2, $3, $4)',
      [tenant_id, DOMAIN, AUTH_ID, REFRESH_ID]
    );
    
    // 2. Create GupShup app for this tenant
    const gupshupApp = await createClientAppWithPartnerAPI({ 
      company: DOMAIN.split('.')[0], 
      tenant_id 
    });
    
    // 3. Save GupShup app info
    await pool.query(
      'INSERT INTO gupshup_apps (tenant_id, gupshup_app_id, gupshup_app_token, app_name, status) VALUES ($1, $2, $3, $4, $5)',
      [tenant_id, gupshupApp.app_id, gupshupApp.app_token, gupshupApp.app_name, 'created']
    );
    
    console.log(`✅ Tenant ${tenant_id} installed successfully for domain ${DOMAIN}`);
    
    // Return success response that Bitrix24 expects
    res.json({ 
      success: true, 
      tenant_id,
      redirect_url: `${process.env.BASE_URL}/setup/${tenant_id}` 
    });
    
  } catch (error) {
    console.error('Installation failed:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Installation failed', 
      details: error.message 
    });
  }
});// ================================
// PHONE NUMBER SETUP
// ================================

// POST /setup/:tenantId/phone
app.post('/setup/:tenantId/phone', async (req, res) => {
  const { tenantId } = req.params;
  let { phone_number, setup_type } = req.body;
  try {
    const { rows } = await pool.query('SELECT * FROM gupshup_apps WHERE tenant_id = $1', [tenantId]);
    const gupshupApp = rows[0];
    if (!gupshupApp) return res.status(404).json({ error: 'GupShup app not found for tenant' });
    if (setup_type === 'existing') {
      await updateAppPhoneNumberWithPartnerAPI(gupshupApp.gupshup_app_id, phone_number);
    } else {
      const newNumber = await requestNewPhoneNumberWithPartnerAPI(gupshupApp.gupshup_app_id);
      phone_number = newNumber.data.phone_number;
    }
    await pool.query(
      'UPDATE gupshup_apps SET phone_number = $1, status = $2 WHERE tenant_id = $3',
      [phone_number, 'phone_configured', tenantId]
    );
    res.json({ success: true, phone_number, next_step: 'verification' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ================================
// MESSAGE SENDING (Tenant → GupShup)
// ================================

// POST /send
app.post('/send', async (req, res) => {
  const { tenant_id, to_number, message } = req.body;
  if (!tenant_id || !to_number || !message) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  try {
    // Get GupShup app for tenant
    const { rows } = await pool.query('SELECT * FROM gupshup_apps WHERE tenant_id = $1', [tenant_id]);
    const appInfo = rows[0];
    if (!appInfo || !appInfo.gupshup_app_token || !appInfo.phone_number) {
      return res.status(400).json({ error: 'WhatsApp not configured for this tenant' });
    }
    const formattedTo = formatPhoneForGupShup(to_number);
    // Prepare message data
    const messageData = {
      channel: 'whatsapp',
      source: appInfo.phone_number,
      destination: formattedTo,
      'src.name': appInfo.app_name,
      message: JSON.stringify({ type: 'text', text: message })
    };
    const formData = new URLSearchParams(messageData);
    // Send message via GupShup
    const gupshupResponse = await axios.post(
      'https://api.gupshup.io/sm/api/v1/msg',
      formData,
      {
        headers: {
          'apikey': appInfo.gupshup_app_token,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        timeout: 10000
      }
    );
    if (gupshupResponse.data.status !== 'submitted') {
      throw new Error(gupshupResponse.data.message || 'Failed to send message via GupShup');
    }
    // Store message
    await pool.query(
      'INSERT INTO messages (tenant_id, gupshup_message_id, direction, from_number, to_number, message_type, content, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [tenant_id, gupshupResponse.data.messageId, 'outbound', appInfo.phone_number, formattedTo, 'text', message, 'sent']
    );
    res.json({ success: true, message: 'Message sent successfully', gupshup_response: gupshupResponse.data });
  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ================================
// MESSAGE RETRIEVAL (Tenant)
// ================================

// GET /messages?tenant_id=...&to_number=...
app.get('/messages', async (req, res) => {
  const { tenant_id, to_number } = req.query;
  if (!tenant_id) return res.status(400).json({ error: 'Missing tenant_id' });
  let query = 'SELECT * FROM messages WHERE tenant_id = $1';
  let params = [tenant_id];
  if (to_number) {
    query += ' AND to_number = $2';
    params.push(to_number);
  }
  query += ' ORDER BY created_at ASC';
  try {
    const result = await pool.query(query, params);
    res.json({ success: true, messages: result.rows });
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve messages' });
  }
});

// ================================
// WEBHOOK (GupShup → Backend, Tenant-Aware)
// ================================

// POST /webhook/:tenantId
app.post('/webhook/:tenantId', async (req, res) => {
  const { tenantId } = req.params;
  const { type, payload } = req.body;
  try {
    // Get GupShup app for tenant
    const { rows } = await pool.query('SELECT * FROM gupshup_apps WHERE tenant_id = $1', [tenantId]);
    const appInfo = rows[0];
    if (!appInfo) return res.status(404).json({ error: 'GupShup app not found for tenant' });
    if (type === 'message' && payload) {
      const { id, source, type: messageType, payload: messagePayload, sender } = payload;
      let messageText = '';
      switch (messageType) {
        case 'text':
          messageText = messagePayload.text || '';
          break;
        case 'image':
          messageText = messagePayload.caption || '[Image]';
          break;
        case 'video':
          messageText = messagePayload.caption || '[Video]';
          break;
        case 'audio':
          messageText = '[Audio]';
          break;
        case 'document':
          messageText = messagePayload.filename || '[Document]';
          break;
        default:
          messageText = `[${messageType}]`;
      }
      await pool.query(
        'INSERT INTO messages (tenant_id, gupshup_message_id, direction, from_number, to_number, message_type, content, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [tenantId, id, 'inbound', source, appInfo.phone_number, messageType, messageText, 'received']
      );
    } else if (type === 'message-event' && payload) {
      const { id, eventType, destination } = payload;
      await pool.query(
        'UPDATE messages SET status = $1 WHERE gupshup_message_id = $2 AND tenant_id = $3',
        [eventType, id, tenantId]
      );
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// ================================
// HEALTH CHECK
// ================================

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString(), service: 'WhatsApp-Bitrix24 Backend', version: '2.0.0' });
});

// ================================
// START SERVER
// ================================

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 Health check: http://localhost:${PORT}/health`);
}); 