/**
 * WhatsApp Engine Service
 * Core WhatsApp connection management
 */

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

let baileys;
let makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers;

// Dynamic import for ES modules
async function loadBaileys() {
    try {
        const baileysModule = await import('@whiskeysockets/baileys');
        makeWASocket = baileysModule.makeWASocket;
        useMultiFileAuthState = baileysModule.useMultiFileAuthState;
        DisconnectReason = baileysModule.DisconnectReason;
        Browsers = baileysModule.Browsers;
        logger.info('✅ Baileys loaded successfully');
    } catch (error) {
        logger.error('❌ Failed to load Baileys:', error);
        process.exit(1);
    }
}

// WhatsApp Engine State
const engineState = {
    sessions: new Map(),
    isInitialized: false
};

// Initialize WhatsApp Engine
async function initializeEngine() {
    await loadBaileys();
    
    // Create sessions directory
    const sessionsDir = path.join(__dirname, '../../whatsapp_sessions');
    if (!fs.existsSync(sessionsDir)) {
        fs.mkdirSync(sessionsDir, { recursive: true });
        logger.info(`📁 Created sessions directory: ${sessionsDir}`);
    }
    
    // Load existing sessions
    await loadExistingSessions();
    
    engineState.isInitialized = true;
    logger.info('📱 WhatsApp Engine initialized');
}

// Load existing sessions from filesystem
async function loadExistingSessions() {
    const sessionsDir = path.join(__dirname, '../../whatsapp_sessions');
    
    try {
        const files = fs.readdirSync(sessionsDir);
        logger.info(`📂 Found ${files.length} stored sessions to restore`);
        
        for (const file of files) {
            if (file.endsWith('.json')) {
                // Session restoration logic here
                logger.debug(`🔄 Found session file: ${file}`);
            }
        }
    } catch (error) {
        logger.warn('⚠️ No existing sessions found');
    }
}

// Create new WhatsApp session
async function createSession(deviceId) {
    try {
        const { state, saveCreds } = await useMultiFileAuthState(
            path.join(__dirname, '../../whatsapp_sessions', deviceId)
        );
        
        const socket = makeWASocket({
            auth: state,
            printQRInTerminal: true,
            browser: Browsers.chrome('linux'),
            logger: logger.waLogger
        });
        
        // Store session
        engineState.sessions.set(deviceId, {
            socket,
            state,
            saveCreds,
            deviceId,
            status: 'connecting',
            qrCode: null,
            connectedAt: null
        });
        
        logger.info(`🔗 Created session for device: ${deviceId}`);
        return socket;
        
    } catch (error) {
        logger.error(`❌ Failed to create session for ${deviceId}:`, error);
        throw error;
    }
}

// Get session by device ID
function getSession(deviceId) {
    return engineState.sessions.get(deviceId);
}

// Get all sessions
function getAllSessions() {
    return Array.from(engineState.sessions.values());
}

// Get engine status
function getEngineStatus() {
    const sessions = getAllSessions();
    const connected = sessions.filter(s => s.status === 'connected').length;
    const qrReady = sessions.filter(s => s.status === 'qr_ready').length;
    
    return {
        status: 'ok',
        engine: 'running',
        port: process.env.PORT || 3002,
        uptime: process.uptime(),
        total_sessions: sessions.length,
        connected: connected,
        qr_ready: qrReady,
        initialized: engineState.isInitialized
    };
}

module.exports = {
    initializeEngine,
    createSession,
    getSession,
    getAllSessions,
    getEngineStatus,
    engineState
};
