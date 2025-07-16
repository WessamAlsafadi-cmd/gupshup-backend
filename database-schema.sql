-- database-schema.sql
-- Create database schema for WhatsApp-Bitrix24 integration

-- Tenants table
CREATE TABLE tenants (
    id VARCHAR(255) PRIMARY KEY,
    bitrix_domain VARCHAR(255) NOT NULL,
    bitrix_auth_id VARCHAR(255),
    bitrix_refresh_token VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- GupShup apps table
CREATE TABLE gupshup_apps (
    id SERIAL PRIMARY KEY,
    tenant_id VARCHAR(255) NOT NULL,
    gupshup_app_id VARCHAR(255),
    gupshup_app_token VARCHAR(255),
    gupshup_api_key VARCHAR(255),
    app_name VARCHAR(255),
    phone_number VARCHAR(20),
    status VARCHAR(32) DEFAULT 'created',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

-- Messages table
CREATE TABLE messages (
    id SERIAL PRIMARY KEY,
    tenant_id VARCHAR(255) NOT NULL,
    gupshup_message_id VARCHAR(255),
    direction VARCHAR(10) NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    from_number VARCHAR(20),
    to_number VARCHAR(20),
    message_type VARCHAR(50),
    content TEXT,
    status VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

-- Indexes for performance
CREATE INDEX idx_tenants_domain ON tenants(bitrix_domain);
CREATE INDEX idx_gupshup_apps_tenant_id ON gupshup_apps(tenant_id);
CREATE INDEX idx_gupshup_apps_phone ON gupshup_apps(phone_number);
CREATE INDEX idx_messages_tenant_id ON messages(tenant_id);
CREATE INDEX idx_messages_gupshup_id ON messages(gupshup_message_id);
CREATE INDEX idx_messages_created_at ON messages(created_at);

-- Webhook logs table (optional)
CREATE TABLE webhook_logs (
    id SERIAL PRIMARY KEY,
    tenant_id VARCHAR(255),
    webhook_type VARCHAR(50) NOT NULL,
    payload JSONB NOT NULL,
    processed BOOLEAN DEFAULT FALSE,
    error_message TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);
CREATE INDEX idx_webhook_logs_tenant_id ON webhook_logs(tenant_id);
CREATE INDEX idx_webhook_logs_type ON webhook_logs(webhook_type);
CREATE INDEX idx_webhook_logs_created_at ON webhook_logs(created_at);

-- ================================
-- SAMPLE DATA (for testing)
-- ================================

-- Add this at the top, after comments
CREATE TABLE bitrix_users (
    user_id VARCHAR(255) PRIMARY KEY,
    domain VARCHAR(255),
    access_token VARCHAR(255),
    refresh_token VARCHAR(255),
    gupshup_token VARCHAR(255),
    phone_number_id VARCHAR(50)
);

-- Remove or update this insert to match your actual messages table columns
-- INSERT INTO messages (lead_id, phone, message_text, direction, user_id, domain) VALUES ...

-- ================================
-- USEFUL QUERIES
-- ================================

-- Get all messages for a specific lead
-- SELECT * FROM messages WHERE lead_id = 1 ORDER BY created_at ASC;

-- Get all messages for a specific phone number
-- SELECT * FROM messages WHERE phone = '+971501234567' ORDER BY created_at ASC;

-- Get conversation count per user
-- SELECT user_id, domain, COUNT(*) as message_count 
-- FROM messages 
-- GROUP BY user_id, domain;

-- Get recent incoming messages
-- SELECT * FROM messages 
-- WHERE direction = 'incoming' 
-- ORDER BY created_at DESC 
-- LIMIT 10; 