/**
 * Unified Backend Server with Integrated WhatsApp Engine
 * - Single Node.js process
 * - WhatsApp Engine as internal module
 * - Persistent sessions
 * - Auto-reconnection
 * - Health checks
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const QRCode = require('qrcode');
const XLSX = require('xlsx');

// NORMALIZE NUMBERS FUNCTION - Fixed to handle both phone/number properties
function normalizeNumbers(contacts) {
  return contacts.map(contact => {
    // Handle both 'phone' and 'number' property names
    let number = contact.phone || contact.number;
    
    // Only add + prefix if it's a real phone number (7-15 digits)
    if (number && !number.startsWith('+') && /^\d{7,15}$/.test(number)) {
      number = '+' + number;
    }
    
    return {
      ...contact,
      phone: number,  // Always use 'phone' property for consistency
      number: number // Keep both for compatibility
    };
  });
}

// Dynamic imports for ES modules
let makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion, makeInMemoryStore, resolveToPhone;

// LID to phone mapping for proper phone number resolution
const lidToPhone = {};

// Process a contact to build LID -> phone mapping
function processContact(contact) {
  if (!contact) return;
  
  const id = contact.id;   // Could be phone JID or LID JID
  const lid = contact.lid;  // LID if available
  
  // If contact has both id (phone) and lid, create mapping
  if (id && lid) {
    const phoneNum = id.split('@')[0].split(':')[0];
    const lidNum = lid.split('@')[0].split(':')[0];
    if (/^\d{7,15}$/.test(phoneNum)) {
      lidToPhone[lidNum] = phoneNum;
      lidToPhone[lid] = phoneNum;
    }
  }
  
  // If id is a phone JID (not LID), store it
  if (id && !id.includes('@lid') && id.includes('@')) {
    const phoneNum = id.split('@')[0].split(':')[0];
    if (/^\d{7,15}$/.test(phoneNum) && lid) {
      const lidNum = lid.split('@')[0].split(':')[0];
      lidToPhone[lidNum] = phoneNum;
    }
  }
}

// Resolve a participant ID to a phone number (local function)
function resolveParticipantToPhone(participantId) {
  if (!participantId) return null;
  
  const raw = participantId.split('@')[0].split(':')[0];
  
  // If it's a regular phone JID
  if (!participantId.includes('@lid') && /^\d{7,15}$/.test(raw)) {
    return raw;
  }
  
  // If it's a LID, try to resolve via mapping
  if (participantId.includes('@lid')) {
    const mapped = lidToPhone[raw] || lidToPhone[participantId];
    if (mapped) return mapped;
  }
  
  return null;
}

async function loadBaileys() {
    try {
        const baileys = await import('@whiskeysockets/baileys');
        makeWASocket = baileys.makeWASocket;
        useMultiFileAuthState = baileys.useMultiFileAuthState;
        DisconnectReason = baileys.DisconnectReason;
        Browsers = baileys.Browsers;
        fetchLatestBaileysVersion = baileys.fetchLatestBaileysVersion || baileys.fetchLatestWaWebVersion;
        
        // Import resolveToPhone for phone number resolution
        resolveToPhone = baileys.resolveToPhone || baileys.default?.resolveToPhone;
        
        // Log if resolveToPhone is available
        if (resolveToPhone) {
            console.log('resolveToPhone function is available');
        } else {
            console.log('resolveToPhone function NOT available - will use fallback strategy');
        }
        
        // Try different ways to get makeInMemoryStore
        makeInMemoryStore = baileys.makeInMemoryStore || 
                          baileys.default?.makeInMemoryStore ||
                          baileys['makeInMemoryStore'] ||
                          baileys.default?.['makeInMemoryStore'];
        
        console.log('Baileys loaded successfully');
        
        // Check if makeInMemoryStore is available
        if (!makeInMemoryStore) {
            console.error('makeInMemoryStore not found in baileys exports');
            console.log('Available exports:', Object.keys(baileys));
            
            // Try to find it in nested objects
            const findInObject = (obj, path = '') => {
                for (const key in obj) {
                    if (key === 'makeInMemoryStore') {
                        console.log(`Found at ${path}${key}:`, typeof obj[key]);
                        return obj[key];
                    }
                    if (typeof obj[key] === 'object' && obj[key] !== null) {
                        const result = findInObject(obj[key], `${path}${key}.`);
                        if (result) return result;
                    }
                }
                return null;
            };
            
            makeInMemoryStore = findInObject(baileys);
            
            if (makeInMemoryStore) {
                console.log('Found makeInMemoryStore through deep search');
            } else {
                console.log('makeInMemoryStore not found anywhere, will proceed without store');
            }
        }
    } catch (error) {
        console.error('Failed to load Baileys:', error);
        process.exit(1);
    }
}

/* =========================
   GLOBAL CRASH PROTECTION
========================= */
process.on('unhandledRejection', (reason, promise) => {
    console.error('🔥 UNHANDLED REJECTION:', reason);
    // Keep process alive
});

process.on('uncaughtException', (error) => {
    console.error('🔥 UNCAUGHT EXCEPTION:', error);
    // Keep process alive
});

/* =========================
   APP SETUP
========================= */
const app = express();
app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));
// Request logger middleware
app.use((req, res, next) => {
    log('info', `📡 INCOMING: ${req.method} ${req.url}`);
    const start = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - start;
        log('info', `✅ FINISHED: ${req.method} ${req.url} - Status: ${res.statusCode} (${duration}ms)`);
    });
    next();
});

// Configuration
const WHATSAPP_ENGINE_PORT = process.env.PORT || process.env.WHATSAPP_ENGINE_PORT || 3002;
const SESSION_DIR = path.join(__dirname, 'whatsapp_sessions');

// Log configuration for debugging
log('info', `🔧 Configuration:`);
log('info', `   PORT from env: ${process.env.PORT}`);
log('info', `   WHATSAPP_ENGINE_PORT from env: ${process.env.WHATSAPP_ENGINE_PORT}`);
log('info', `   Final port: ${WHATSAPP_ENGINE_PORT}`);
log('info', `   BACKEND_URL: ${process.env.BACKEND_URL || 'http://127.0.0.1:8000'}`);
log('info', `   Session directory: ${SESSION_DIR}`);

// WhatsApp Engine State
const sessions = new Map();
const qrCache = new Map();
const connectionPromises = new Map();
let isEngineInitialized = false;

/* =========================
   LOGGER
========================= */
function log(level, msg, data = null) {
    const time = new Date().toISOString();
    const prefix = `[${time}] [${level.toUpperCase()}]`;
    console.log(`${prefix} ${msg}`);
    if (data) {
        try {
            console.log(JSON.stringify(data, null, 2));
        } catch (e) {
            console.log('Data serialization failed:', e.message);
        }
    }
}

/* =========================
   AUTH STATE MANAGER
========================= */
async function ensureAuthDir(deviceId) {
    const authDir = path.join(SESSION_DIR, deviceId);
    try {
        if (!fs.existsSync(authDir)) {
            fs.mkdirSync(authDir, { recursive: true });
            log('info', `Created auth directory: ${authDir}`);
        }
        return authDir;
    } catch (error) {
        log('error', `Failed to create auth dir for ${deviceId}`, error);
        throw error;
    }
}

/* =========================
   QR HANDLER
========================= */
async function handleQR(deviceId, qr) {
    try {
        log('info', `QR received for device: ${deviceId}`);
        const base64 = await QRCode.toDataURL(qr);

        qrCache.set(deviceId, base64);

        const session = sessions.get(deviceId);
        if (session) {
            session.qr = base64;
            session.status = 'qr_ready';
            session.qrGeneratedAt = Date.now();
        }

        log('info', `✅ QR processed successfully for: ${deviceId}`);
        return base64;
    } catch (error) {
        log('error', `QR generation failed for ${deviceId}`, error);
        throw error;
    }
}

/* =========================
   CONNECTION MANAGER
========================= */
async function createConnection(deviceId) {
    // Ensure baileys is loaded
    if (!makeWASocket) {
        await loadBaileys();
    }

    const authDir = await ensureAuthDir(deviceId);

    log('info', `Creating Baileys socket for: ${deviceId}`);

    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    // Create in-memory store and bind it (optional)
    let store;
    if (makeInMemoryStore && typeof makeInMemoryStore === 'function') {
        try {
            store = makeInMemoryStore({});
            log('info', `Store created successfully for ${deviceId}`);
        } catch (storeError) {
            log('warn', `Failed to create store for ${deviceId}: ${storeError.message}`);
            log('warn', `Proceeding without store - group fetching will use direct API`);
            store = null;
        }
    } else {
        log('warn', `makeInMemoryStore not available, proceeding without store`);
        store = null;
    }

    let version = [2, 3000, 1015901307]; // Robust fallback
    try {
        if (fetchLatestBaileysVersion) {
            const result = await fetchLatestBaileysVersion();
            if (result && result.version) {
                version = result.version;
                log('info', `Using WA version: ${version.join('.')}`);
            }
        }
    } catch (e) {
        log('warn', `Failed to fetch latest WA version, using fallback: ${e.message}`);
    }

    const socket = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false, // Don't print QR in terminal
        browser: ['Ubuntu', 'Chrome', '20.0.04'], // Robust browser string
        connectTimeoutMs: 60000,
        retryRequestDelayMs: 5000,
        maxRetries: 5,
        keepAliveIntervalMs: 25000,
        emitOwnEvents: false,
    });

    // Bind store to socket events (optional)
    if (store && store.bind && typeof store.bind === 'function') {
        try {
            store.bind(socket.ev);
            log('info', `Store bound successfully to socket for ${deviceId}`);
        } catch (bindError) {
            log('warn', `Failed to bind store for ${deviceId}: ${bindError.message}`);
            log('warn', `Proceeding without store binding`);
        }
    } else if (store) {
        log('warn', `Store exists but no bind method available`);
    }

    const session = {
        socket,
        store,
        status: 'connecting',
        qr: null,
        reconnects: 0,
        lastDisconnect: null,
        createdAt: Date.now(),
        qrGeneratedAt: null,
        lastSyncedStatus: null,
    };

    sessions.set(deviceId, session);

    return { socket, session, saveCreds };
}

// Notify backend about device status changes with retry logic
async function updateBackendStatus(deviceId, status, retries = 3) {
    const session = sessions.get(deviceId);
    if (!session) return false;

    // 🔥 PREVENT REDUNDANT UPDATES (Saves backend resources)
    if (session.lastSyncedStatus === status) {
        // log('info', `⏭️ Skipping redundant status sync for ${deviceId}: ${status}`);
        return true;
    }

    let rawUrl = process.env.BACKEND_URL || 'http://127.0.0.1:8000';
    // 🔥 ROBUST FIX: Remove trailing /api to prevent double-prefixing. 
    // The engine adds its own endpoint path correctly.
    const backendUrl = rawUrl.endsWith('/api') ? rawUrl.slice(0, -4) : rawUrl;
    
    // Use a simpler approach without excessive retries if the backend is busy
    try {
        log('info', `📡 Syncing status to backend for ${deviceId}: ${status}`);
        await axios.patch(`${backendUrl}/api/devices/${deviceId}/status`, {
            status: status,
            session_status: status
        }, { timeout: 10000 }); // Increased timeout to prevent sync failures
        
        session.lastSyncedStatus = status;
        log('info', `✅ Backend status synced successfully: ${status}`);
        return true;
    } catch (err) {
        const statusCode = err.response?.status;
        const detail = err.response?.data?.detail || err.message;
        log('error', `⚠️ Failed to sync status to backend for ${deviceId}: ${JSON.stringify(detail)} (Status: ${statusCode})`);
        
        // 🔥 CRITICAL: Only purge if it's REALLY a device missing (confirmed by backend detail)
        // A generic 404 might mean a misconfigured BACKEND_URL (incorrect route).
        if (statusCode === 404 && (JSON.stringify(detail).toLowerCase().includes('not found') || JSON.stringify(detail).toLowerCase().includes('uuid'))) {
            log('warn', `🛑 Device ${deviceId} confirmed not found in backend. Purging local session to stop reconnect loops.`);
            
            const session = sessions.get(deviceId);
            if (session) {
                // Remove listeners to prevent further events triggering syncs
                if (session.socket && session.socket.ev) {
                    session.socket.ev.removeAllListeners();
                    try { session.socket.end(); } catch(e) {}
                }
                
                sessions.delete(deviceId);
                qrCache.delete(deviceId);
                
                // Remove physical session files
                try {
                    const sessionPath = path.join(SESSION_DIR, deviceId);
                    if (fs.existsSync(sessionPath)) {
                        fs.rmSync(sessionPath, { recursive: true, force: true });
                        log('info', `🧹 Deleted stale session directory: ${sessionPath}`);
                    }
                } catch (e) {
                    log('warn', `Failed to delete session dir for ${deviceId}`, e);
                }
            }
            
            return false;
        }
        
        // Only one retry with longer delay if it fails for other reasons
        if (retries > 1) {
            setTimeout(() => updateBackendStatus(deviceId, status, retries - 1), 5000);
        }
        return false;
    }
}

// Health check to ensure backend is reachable
async function waitForBackend(retries = 10) {
    const backendUrl = process.env.BACKEND_URL || 'http://127.0.0.1:8000';
    log('info', `🔍 Checking backend availability at ${backendUrl}...`);
    for (let i = 0; i < retries; i++) {
        try {
            await axios.get(`${backendUrl}/health`, { timeout: 5000 });
            log('info', `✅ Backend is UP and reachable.`);
            return true;
        } catch (err) {
            log('warn', `⏳ [${i + 1}/${retries}] Backend not reachable yet. Retrying in 5s...`);
            await new Promise(r => setTimeout(r, 5000));
        }
    }
    log('error', `❌ Backend unreachable after ${retries} attempts. Engine starting anyway...`);
    return false;
}

/* =========================
   INIT SESSION (SINGLETON)
========================= */
async function initSession(deviceId) {
    log('info', `🚀 Initializing session: ${deviceId}`);

    if (connectionPromises.has(deviceId)) {
        log('info', `Session already initializing: ${deviceId}`);
        return connectionPromises.get(deviceId);
    }

    const initPromise = (async () => {
        try {
            // Create connection
            const { socket, session, saveCreds } = await createConnection(deviceId);
            
            // Build LID to phone mapping from contact events
            socket.ev.on('contacts.upsert', (contacts) => {
              for (const contact of contacts) {
                processContact(contact);
              }
              log('info', `Contacts mapping updated. Total LID mappings: ${Object.keys(lidToPhone).length}`);
            });

            socket.ev.on('contacts.update', (contacts) => {
              for (const contact of contacts) {
                processContact(contact);
              }
            });

            // Handle connection updates
            socket.ev.on('connection.update', async (update) => {
              try {
                const { connection, lastDisconnect, qr } = update;
                const code = lastDisconnect?.error?.output?.statusCode;
                const disconnectReason = lastDisconnect?.error?.message || DisconnectReason[code] || 'unknown';

                if (qr) {
                    log('info', `QR Code received for ${deviceId}`);
                    try {
                        const qrImageData = await QRCode.toDataURL(qr);
                        session.qr = qrImageData;
                        session.hasQR = true;
                        session.qrGeneratedAt = Date.now();

                        if (typeof io !== 'undefined' && io) {
                            io.emit('qr_code', {
                                deviceId: deviceId,
                                qrCode: qrImageData,
                                timestamp: new Date().toISOString()
                            });
                        }
                    } catch (qrError) {
                        log('error', `Failed to generate QR image: ${qrError.message}`);
                    }
                }

                if (connection === 'open') {
                    log('info', `✅ WhatsApp connection OPEN for ${deviceId}`);
                    session.status = 'connected';
                    session.connectedAt = Date.now();
                    session.hasQR = false;
                    session.qr = null;
                    session.reconnects = 0;
                    
                    await updateBackendStatus(deviceId, 'connected');
                    
                    if (typeof io !== 'undefined' && io) {
                        io.emit('connection_status', {
                            deviceId: deviceId,
                            status: 'connected',
                            timestamp: new Date().toISOString()
                        });
                    }
                } else if (connection === 'close') {
                    const shouldReconnect = (code !== DisconnectReason.loggedOut);
                    log('info', `WhatsApp connection closed for ${deviceId}. Code: ${code}, Reason: ${disconnectReason}, Should reconnect: ${shouldReconnect}`);
                    
                    session.status = 'disconnected';
                    session.hasQR = false;
                    session.qr = null;
                    
                    // Only notify backend of disconnect if NOT reconnecting
                    // This prevents premature 'disconnected' status during QR handshake
                    if (!shouldReconnect) {
                        await updateBackendStatus(deviceId, 'disconnected');
                    } else {
                        log('info', `⏳ Skipping backend disconnect notification for ${deviceId} - will auto-reconnect`);
                    }
                    
                    if (typeof io !== 'undefined' && io) {
                        io.emit('connection_status', {
                            deviceId: deviceId,
                            status: shouldReconnect ? 'connecting' : 'disconnected',
                            timestamp: new Date().toISOString()
                        });
                    }
                    
                    if (shouldReconnect) {
                        session.reconnects++;
                        const delay = Math.min(30000, Math.pow(2, session.reconnects) * 1000);
                        
                        log('warn', `WhatsApp disconnected ${deviceId}`, {
                            code,
                            reason: disconnectReason,
                            reconnectAttempt: session.reconnects,
                            nextRetryIn: `${delay}ms`
                        });

                        log('info', `Auto-reconnecting ${deviceId} in ${delay}ms (attempt ${session.reconnects})`);
                        connectionPromises.delete(deviceId); // Clear promise so initSession can run
                        setTimeout(() => initSession(deviceId), delay);
                    } else {
                        log('warn', `User logged out from mobile - ${deviceId}`);
                        session.status = 'logged_out';
                        await updateBackendStatus(deviceId, 'logged_out');
                        sessions.delete(deviceId);
                        qrCache.delete(deviceId);
                        try {
                            fs.rmSync(path.join(SESSION_DIR, deviceId), { recursive: true, force: true });
                        } catch (e) {
                            log('warn', `Failed to delete session dir for ${deviceId}`, e);
                        }
                    }
                } else if (connection === 'connecting') {
                    log('info', `🔄 WhatsApp connecting for ${deviceId}`);
                    session.status = 'connecting';
                    
                    // Notify backend that device is in connecting state
                    await updateBackendStatus(deviceId, 'connecting');
                    
                    if (typeof io !== 'undefined' && io) {
                        io.emit('connection_status', {
                            deviceId: deviceId,
                            status: 'connecting',
                            timestamp: new Date().toISOString()
                        });
                    }
                }
              } catch (connError) {
                  log('error', `🔥 CRITICAL: connection.update handler error for ${deviceId}: ${connError.message}`);
                  log('error', `Stack: ${connError.stack}`);
                  // DO NOT crash - keep event listener alive
              }
            });

            // Handle Incoming Messages (Disabled per user request)
            socket.ev.on('messages.upsert', async (upsert) => {
                // log('info', `📨 Incoming message event received (Processing: Disabled)`);
            });

            // 🔥 Real-time Message Status Tracker (For Delivery Reports)
            socket.ev.on('message-receipt.update', async (receipts) => {
                const backendUrl = process.env.BACKEND_URL || 'http://127.0.0.1:8000';
                for (const receipt of receipts) {
                    const messageId = receipt.key.id;
                    const statusNumber = receipt.receipt.receiptTimestamp ? 3 : 2; // Rough mapping
                    
                    // Baileys typically sends status updates in 'receipt' object
                    // Status 3 = Delivered, 4 = Read
                    // We check if it's from a person (not status)
                    if (receipt.key.remoteJid && !receipt.key.remoteJid.includes('broadcast')) {
                         try {
                              // We use the most advanced status available in the receipt
                              let finalStatus = 'sent';
                              if (receipt.receipt.readTimestamp) finalStatus = 'read';
                              else if (receipt.receipt.receiptTimestamp) finalStatus = 'delivered';

                              // log('info', `📫 Status Update for ${messageId}: ${finalStatus}`);
                              
                              await axios.post(`${backendUrl}/api/webhooks/whatsapp/status`, {
                                   device_id: deviceId,
                                   message_id: messageId,
                                   status: finalStatus
                              }, { timeout: 5000 }).catch(() => {});
                         } catch (err) {}
                    }
                }
            });

            // Credentials update handler
            socket.ev.on('creds.update', saveCreds);

            // Error handler
            socket.ev.on('error', (err) => {
                log('error', `Socket error for ${deviceId}`, err);
            });

            log('info', `✅ Session initialized successfully: ${deviceId}`);
            return session;

        } catch (error) {
            log('error', `❌ Failed to initialize session: ${deviceId}`, error);
            connectionPromises.delete(deviceId);
            throw error;
        }
    })();

    connectionPromises.set(deviceId, initPromise);

    try {
        return await initPromise;
    } finally {
        connectionPromises.delete(deviceId);
    }
}

/* =========================
   VALIDATE DEVICE IN BACKEND DB
========================= */
async function isDeviceInDatabase(deviceId) {
    const backendUrl = process.env.BACKEND_URL || 'http://127.0.0.1:8000';
    try {
        const response = await axios.get(`${backendUrl}/api/devices/${deviceId}`, { timeout: 5000 });
        return response.status === 200;
    } catch (err) {
        if (err.response && err.response.status === 404) {
            return false;
        }
        // If backend is unreachable or other error, assume device exists to be safe
        log('warn', `⚠️ Could not verify device ${deviceId} in backend: ${err.message}. Assuming it exists.`);
        return true;
    }
}

/* =========================
   HEARTBEAT MONITOR
========================= */
// 🔥 CRITICAL: Heartbeat mechanism to detect dead connections and prevent false disconnects
const heartbeatInterval = 20000; // 20 seconds
let heartbeatTimer = null;

function startHeartbeat() {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
    }
    
    heartbeatTimer = setInterval(() => {
        const now = Date.now();
        for (const [deviceId, session] of sessions.entries()) {
            if (session.status === 'connected') {
                // Check if session is still responsive
                const timeSinceConnected = now - (session.connectedAt || now);
                const timeSinceLastActivity = now - (session.lastActivity || session.connectedAt || now);
                
                // Log heartbeat for monitoring
                log('info', `💓 Heartbeat check for ${deviceId}: connected for ${Math.floor(timeSinceConnected / 1000)}s, last activity ${Math.floor(timeSinceLastActivity / 1000)}s ago`);
                
                // Update last activity timestamp
                session.lastActivity = now;
            }
        }
    }, heartbeatInterval);
    
    log('info', `💓 Heartbeat monitor started (interval: ${heartbeatInterval}ms)`);
}

function stopHeartbeat() {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
        log('info', '💓 Heartbeat monitor stopped');
    }
}

/* =========================
   AUTO-RESTORE SESSIONS
========================= */
async function restoreSessions() {
    if (!fs.existsSync(SESSION_DIR)) {
        log('info', 'No sessions directory found, starting fresh');
        return;
    }

    try {
        const dirs = fs.readdirSync(SESSION_DIR);
        log('info', `📂 Found ${dirs.length} stored sessions to restore...`);

        for (const deviceId of dirs) {
            // Skip non-directories or system files
            if (deviceId.startsWith('.')) continue;

            try {
                // Validate device exists in backend database before restoring
                const existsInDb = await isDeviceInDatabase(deviceId);
                if (!existsInDb) {
                    log('warn', `🗑️ Device ${deviceId} NOT found in database. Removing orphaned session...`);
                    try {
                        fs.rmSync(path.join(SESSION_DIR, deviceId), { recursive: true, force: true });
                        log('info', `✅ Orphaned session directory deleted for: ${deviceId}`);
                    } catch (rmErr) {
                        log('error', `Failed to delete orphaned session dir for ${deviceId}`, rmErr);
                    }
                    continue;
                }

                log('info', `🔄 Restoring session: ${deviceId} (verified in database)`);
                await initSession(deviceId);
            } catch (e) {
                log('error', `Failed to restore ${deviceId}`, e);
            }
        }
    } catch (e) {
        log('error', 'Failed to read sessions directory', e);
    }
}

/* =========================
   WHATSAPP ENGINE API ROUTES
========================= */

// Root Health Check (Simple)
app.get('/', (req, res) => {
    res.json({
        status: 'online',
        engine: 'WhatsApp Engine is up and running',
        timestamp: new Date().toISOString()
    });
});

// Health Check (Comprehensive)
app.get('/health', (req, res) => {
    try {
        const sessionArray = Array.from(sessions.values());
        const connectedCount = sessionArray.filter(s => s && s.status === 'connected').length;
        const qrReadyCount = sessionArray.filter(s => s && s.status === 'qr_ready').length;

        const healthData = {
            status: 'ok',
            engine: 'running',
            port: WHATSAPP_ENGINE_PORT,
            uptime: process.uptime(),
            sessions: {
                total: sessions.size,
                connected: connectedCount,
                qr_ready: qrReadyCount
            },
            timestamp: new Date().toISOString()
        };

        if (connectedCount > 0) {
            healthData.whatsapp = 'connected';
            healthData.message = 'WhatsApp engine is connected and ready';
        } else if (qrReadyCount > 0) {
            healthData.whatsapp = 'qr_ready';
            healthData.message = 'WhatsApp engine is waiting for QR scan';
        } else {
            healthData.whatsapp = 'disconnected';
            healthData.message = 'WhatsApp engine is running but no active sessions';
        }

        // Log detailed session info for debugging
        log('info', '📊 Health Check Results:', {
            total_sessions: sessions.size,
            connected_devices: connectedCount,
            qr_ready_devices: qrReadyCount,
            session_details: sessionArray.map(s => ({
                device_id: s.deviceId,
                status: s.status,
                has_qr: !!s.qr,
                connected_at: s.connectedAt,
                qr_generated_at: s.qrGeneratedAt
            }))
        });

        res.json(healthData);
    } catch (error) {
        log('error', 'Health check failed', error);
        res.status(200).json({ 
            status: 'degraded',
            engine: 'running',
            port: WHATSAPP_ENGINE_PORT,
            message: 'Engine running but health check failed',
            timestamp: new Date().toISOString()
        });
    }
});

// Readiness check for Render
app.get('/ready', (req, res) => {
    res.status(200).json({ 
        status: 'ready',
        message: 'WhatsApp Engine is ready to accept connections',
        port: WHATSAPP_ENGINE_PORT
    });
});

// Debug endpoint to check connection status
app.get('/debug/sessions', (req, res) => {
    try {
        const sessionArray = Array.from(sessions.entries());
        const debugInfo = {
            total_sessions: sessions.size,
            sessions: sessionArray.map(([deviceId, session]) => ({
                device_id: deviceId,
                status: session.status,
                has_qr: !!session.qr,
                qr_generated_at: session.qrGeneratedAt,
                connected_at: session.connectedAt,
                reconnects: session.reconnects,
                last_disconnect: session.lastDisconnect,
                created_at: session.createdAt
            })),
            timestamp: new Date().toISOString()
        };
        
        log('info', '🔍 Debug Session Info:', debugInfo);
        res.json(debugInfo);
    } catch (error) {
        log('error', 'Debug endpoint failed', error);
        res.status(500).json({ error: 'Failed to get debug info' });
    }
});

// Get all sessions
app.get('/sessions', (req, res) => {
    const data = {};
    sessions.forEach((session, id) => {
        data[id] = {
            status: session.status,
            has_qr: !!session.qr,
            reconnects: session.reconnects,
            created_at: session.createdAt,
            connected_at: session.connectedAt || null,
            qr_generated_at: session.qrGeneratedAt || null,
            last_disconnect: session.lastDisconnect || null,
        };
    });
    res.json(data);
});

// Get QR for device
app.get('/session/:deviceId/qr', async (req, res) => {
    const { deviceId } = req.params;

    log('info', `QR requested for device: ${deviceId}`);

    let session = sessions.get(deviceId);

    // Auto-initialize if session doesn't exist
    if (!session) {
        // Validate device exists in database before initializing
        const existsInDb = await isDeviceInDatabase(deviceId);
        if (!existsInDb) {
            log('warn', `❌ QR requested for device ${deviceId} which does NOT exist in database. Rejecting.`);
            return res.status(404).json({
                status: 'error',
                message: 'Device not found in database'
            });
        }

        log('info', `Auto-initializing session for: ${deviceId}`);
        try {
            await initSession(deviceId);
            session = sessions.get(deviceId);

            // Wait a bit for QR generation
            if (session && session.status === 'connecting') {
                await new Promise(resolve => setTimeout(resolve, 3000));
                session = sessions.get(deviceId);
            }
        } catch (error) {
            log('error', `Failed to auto-init session for ${deviceId}`, error);
            return res.status(500).json({
                status: 'error',
                message: 'Failed to initialize session'
            });
        }
    }

    if (!session) {
        return res.status(500).json({
            status: 'error',
            message: 'Session creation failed'
        });
    }

    // Return based on session status
    if (session.status === 'connected') {
        return res.json({ status: 'connected' });
    }

    if (session.qr) {
        return res.json({
            status: 'qr_ready',
            qr: session.qr,
            generated_at: session.qrGeneratedAt
        });
    }

    // Still generating QR
    res.status(202).json({
        status: 'generating',
        message: 'QR code is being generated'
    });
});

// Get device status
app.get('/session/:deviceId/status', (req, res) => {
    const { deviceId } = req.params;
    const session = sessions.get(deviceId);

    if (!session) {
        return res.status(404).json({
            status: 'not_found',
            message: 'Device session not found'
        });
    }

    res.json({
        status: session.status,
        has_qr: !!session.qr,
        reconnects: session.reconnects,
        created_at: session.createdAt,
        connected_at: session.connectedAt || null,
    });
});

// Delete session
app.delete('/session/:deviceId', async (req, res) => {
    const { deviceId } = req.params;
    log('info', `🗑️ Session deletion requested for: ${deviceId}`);

    try {
        const session = sessions.get(deviceId);
        
        if (session) {
            // Stop socket and remove listeners
            if (session.socket && session.socket.ev) {
                session.socket.ev.removeAllListeners();
            }
            try {
                session.status = 'disconnected';
                if (session.socket) {
                    session.socket.end(undefined);
                }
            } catch (e) {
                log('error', `Failed to end socket for ${deviceId}`, e);
            }
            
            sessions.delete(deviceId);
            qrCache.delete(deviceId);
            log('info', `✅ Session ${deviceId} removed from memory`);
        }

        // Remove files from disk
        const sessionPath = path.join(SESSION_DIR, deviceId);
        if (fs.existsSync(sessionPath)) {
            try {
                fs.rmSync(sessionPath, { recursive: true, force: true });
                log('info', `✅ Deleted session directory: ${sessionPath}`);
            } catch (e) {
                log('error', `⚠️ Failed to delete session dir for ${deviceId}: ${e.message}`);
            }
        }

        res.json({
            success: true,
            message: 'Session deleted successfully'
        });
    } catch (error) {
        log('error', `❌ Failed to delete session ${deviceId}`, error);
        res.status(500).json({
            success: false,
            error: 'internal_error',
            message: error.message
        });
    }
});

// Start session manually
app.post('/session/:deviceId/start', async (req, res) => {
    const { deviceId } = req.params;
    log('info', `Manual session start requested for: ${deviceId}`);

    try {
        let session = sessions.get(deviceId);

        if (!session) {
            // Validate device exists in database before starting
            const existsInDb = await isDeviceInDatabase(deviceId);
            if (!existsInDb) {
                log('warn', `❌ Session start requested for device ${deviceId} which does NOT exist in database. Rejecting.`);
                return res.status(404).json({
                    status: 'error',
                    message: 'Device not found in database'
                });
            }

            // initSession is async and will set up the connection
            await initSession(deviceId);
            session = sessions.get(deviceId);

            // Wait briefly to allow state change
            if (session && session.status === 'connecting') {
                await new Promise(resolve => setTimeout(resolve, 2000));
                session = sessions.get(deviceId);
            }
        }

        res.json({
            status: session?.status || 'connecting',
            message: 'Session initialization started'
        });
    } catch (error) {
        log('error', `Failed to start session for ${deviceId}`, error);
        res.status(500).json({
            status: 'error',
            message: 'Failed to start session: ' + error.message
        });
    }
});

// Send message
app.post('/session/:deviceId/message', async (req, res) => {
    const { deviceId } = req.params;
    const { to, message, type = 'text', wait = false } = req.body;

    // Always return a response immediately
    const immediateResponse = (status, data, statusCode = 200) => {
        if (status === 'error') {
            return res.status(statusCode).json({
                status: 'error',
                error: data.error,
                message: data.message,
                timestamp: new Date().toISOString()
            });
        } else {
            return res.status(statusCode).json({
                status: 'accepted',
                messageId: data.messageId || `pending_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                to: data.to || to,
                timestamp: new Date().toISOString(),
                note: 'Message queued for delivery'
            });
        }
    };

    // Validation
    if (!to || !message) {
        return immediateResponse('error', {
            error: 'missing_parameters',
            message: 'Both "to" and "message" are required'
        }, 400);
    }

    const session = sessions.get(deviceId);
    if (!session) {
        return immediateResponse('error', {
            error: 'device_not_found',
            message: 'Device session not found'
        }, 404);
    }

    if (session.status !== 'connected') {
        return immediateResponse('error', {
            error: 'device_not_connected',
            status: session.status,
            message: 'Device is not connected'
        }, 400);
    }

    // 🔥 REAL-TIME SOCKET HEALTH CHECK
    // In Baileys v7, socket.ws.readyState might not exist. Check isOpen or let the timeout handle it.
    const isSocketOpen = session.socket && (typeof session.socket.ws?.isOpen === 'function' ? session.socket.ws.isOpen() : true);
    
    if (!isSocketOpen) {
        log('error', `❌ [SESSION_STUCK] Zombie socket detected for: ${deviceId}. Triggering auto-reinit...`);
        // Kick off session reinitialization in background
        setImmediate(async () => {
            try {
                log('info', `🔄 [AUTO_REINIT] Reinitializing zombie session: ${deviceId}`);
                await initSession(deviceId);
            } catch (err) {
                log('error', `❌ [AUTO_REINIT] Failed to reinit session ${deviceId}: ${err.message}`);
            }
        });
        return immediateResponse('error', {
            error: 'socket_not_ready',
            message: 'WhatsApp connection lost. Auto-reconnect triggered. Please wait 15-30 seconds and try again.'
        }, 503);
    }

    // Robust JID construction - ensure no + signs for unofficial JIDs
    const cleanTo = to.includes('@') ? to : to.replace(/\+/g, '').replace(/\s/g, '');
    const jid = cleanTo.includes('@') ? cleanTo : `${cleanTo}@s.whatsapp.net`;
    const pendingMessageId = `pending_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
 
    // Core sending logic
    const sendFn = async () => {
        log('info', `📡 [MSG_SENDING] Sending message to ${to}`);
        try {
            // ── VERIFICATION ────────────────────────────────────────────────
            // If synchronous 'wait' is requested, verify if the number is on WA first
            if (wait) {
                log('info', `🔍 [VERIFYING] Checking if ${jid} is on WhatsApp...`);
                const [exists] = await session.socket.onWhatsApp(jid);
                if (!exists || !exists.exists) {
                    const error = new Error(`Number ${to} is not registered on WhatsApp`);
                    error.code = 'invalid_number';
                    throw error;
                }
                log('info', `✅ [VERIFIED] ${jid} exists on WhatsApp.`);
            }

            // Prepare message object
            let messageObj;
            if (type === 'text') {
                messageObj = { text: message };
            } else {
                messageObj = { image: { url: message }, caption: message };
            }

            const result = await Promise.race([
                session.socket.sendMessage(jid, messageObj),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Send Timeout')), 30000))
            ]);

            log('info', `✅ [MSG_DELIVERED] Message sent from ${deviceId} to ${jid}`, { 
                messageId: pendingMessageId,
                actualId: result?.key?.id 
            });
            
            // Store status in memory
            if (!session.messageStatus) session.messageStatus = new Map();
            session.messageStatus.set(pendingMessageId, { 
                status: 'sent', 
                actualMessageId: result?.key?.id,
                timestamp: new Date() 
            });
            
            return result;
        } catch (error) {
            log('error', `❌ [MSG_DELIVERY_FAILED] failure to ${jid} from ${deviceId}: ${error.message}`);
            
            if (!session.messageStatus) session.messageStatus = new Map();
            session.messageStatus.set(pendingMessageId, { 
                status: 'failed', 
                error: error.message,
                timestamp: new Date() 
            });
            
            throw error;
        }
    };

    if (wait) {
        // Synchronous mode
        try {
            const result = await sendFn();
            return res.json({
                status: 'sent',
                messageId: result?.key?.id || pendingMessageId,
                to: jid,
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            const statusCode = (error.code === 'invalid_number' || error.message.includes('not registered')) ? 400 : 500;
            return res.status(statusCode).json({
                status: 'error',
                error: error.code || 'unknown_error',
                message: error.message,
                timestamp: new Date().toISOString()
            });
        }
    } else {
        // Async mode (default)
        setImmediate(sendFn);
        return immediateResponse('accepted', { to: jid, messageId: pendingMessageId });
    }
});

// 🧪 ZERO-DEPENDENCY FILE HANDLER (Bypasses Multer NPME Installation Issues)
// Backend passes metadata in custom X-WA-* headers
app.post('/session/:deviceId/file', express.raw({ type: 'application/octet-stream', limit: '100mb' }), async (req, res) => {
    try {
        const { deviceId } = req.params;
        // 🔥 DECODE HEADERS: Backend now URL-encodes these to support Marathi/Unicode
        const to = decodeURIComponent(req.get('X-WA-To') || '');
        const filename = decodeURIComponent(req.get('X-WA-Filename') || 'file');
        const caption = decodeURIComponent(req.get('X-WA-Caption') || '');
        const mimeType = req.get('X-WA-MimeType') || 'application/octet-stream';
        
        const wait = req.get('X-WA-Wait') === 'true';
        log('info', `📤 [RAW_FILE_ENDPOINT] Received binary file for ${to} (${filename}), caption=${caption}, wait=${wait}`);

        if (!to || !req.body) {
            return res.status(400).json({ success: false, error: 'missing_params', message: 'Target number or binary data missing' });
        }

        const session = sessions.get(deviceId);
        if (!session || session.status !== 'connected') {
            return res.status(400).json({ success: false, error: 'not_connected', message: 'Device not connected' });
        }

        const ext = filename.split('.').pop().toLowerCase();
        const fileBuffer = req.body;

        let formattedNumber = to;
        if (!formattedNumber.includes('@')) {
            formattedNumber = formattedNumber.replace(/\D/g, '');
            formattedNumber = formattedNumber + '@s.whatsapp.net';
        }

        const sendFileFn = async () => {
            log('info', `🚀 [RAW_FILE_SEND] Sending binary via Baileys: ${filename}`);

            let message;
            const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff', 'heic'];
            const videoExts = ['mp4', 'mov', 'avi', 'mkv', 'wmv', 'flv', 'webm'];

            // CASE-INSENSITIVE EXTENSION CHECK
            const cleanExt = ext.toLowerCase();

            if (imageExts.includes(cleanExt)) {
                message = { image: fileBuffer, caption: caption || filename, mimetype: mimeType };
            } else if (videoExts.includes(cleanExt)) {
                message = { video: fileBuffer, caption: caption || filename, mimetype: mimeType };
            } else {
                message = { 
                    document: fileBuffer, 
                    fileName: filename, 
                    mimetype: mimeType, 
                    caption: caption || `📄 ${filename}` 
                };
            }

            const sendResult = await session.socket.sendMessage(formattedNumber, message);
            log('info', `✅ [RAW_FILE_SEND] Binary file sent successfully`);
            return sendResult;
        };

        if (wait) {
            try {
                const result = await sendFileFn();
                return res.json({
                    success: true,
                    status: 'sent',
                    messageId: result?.key?.id,
                    to: formattedNumber,
                    timestamp: new Date().toISOString()
                });
            } catch (error) {
                const statusCode = (error.code === 'invalid_number' || error.message.includes('not registered')) ? 400 : 500;
                return res.status(statusCode).json({
                    success: false,
                    status: 'error',
                    error: error.code || 'unknown_error',
                    message: error.message,
                    timestamp: new Date().toISOString()
                });
            }
        } else {
            // Background send
            setImmediate(async () => {
                try {
                    await sendFileFn();
                } catch (err) {
                    log('error', `❌ [RAW_FILE_ASYNC] Failure: ${err.message}`);
                }
            });

            return res.status(202).json({
                success: true,
                status: 'accepted',
                messageId: `pending_raw_${Date.now()}`,
                note: 'Binary file accepted'
            });
        }
    } catch (err) {
        log('error', `❌ [RAW_FILE_CRASH] ${err.message}`);
        return res.status(500).json({ success: false, message: err.message });
    }
});

// Backward compatibility alias
app.post('/session/:deviceId/file-caption', express.raw({ type: 'application/octet-stream', limit: '100mb' }), async (req, res) => {
    req.url = `/session/${req.params.deviceId}/file`;
    return app._router.handle(req, res);
});



// Send file with base64 data
app.post('/session/:deviceId/base64-file', async (req, res) => {
    try {
        const { deviceId } = req.params;
        const { to, base64_data, filename, caption, wait = false } = req.body;

        log('info', `📤 [BASE64_FILE_ENDPOINT] Received base64 file send request, wait=${wait}`);

        if (!to || !base64_data || !filename) {
            return res.status(400).json({ success: false, error: 'missing_params', message: 'Target number, base64 data, or filename missing' });
        }

        const session = sessions.get(deviceId);
        if (!session || session.status !== 'connected') {
            return res.status(400).json({ success: false, error: 'not_connected', message: 'Device not connected' });
        }

        const sendBase64Fn = async () => {
            log('info', `📤 [BASE64_FILE_SEND] Sending file to ${to}`);
            
            let base64String = base64_data;
            if (base64String.startsWith('data:')) {
                base64String = base64String.split(',')[1];
            }
            const fileBuffer = Buffer.from(base64String, 'base64');

            let formattedNumber = to;
            if (!formattedNumber.includes('@')) {
                formattedNumber = formattedNumber.replace(/\D/g, '');
                formattedNumber = formattedNumber + '@s.whatsapp.net';
            }

            const ext = (filename || '').split('.').pop().toLowerCase();
            const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff'];
            const videoExts = ['mp4', 'avi', 'mov', 'mkv', '3gp', 'webm'];
            const audioExts = ['mp3', 'ogg', 'wav', 'aac', 'm4a', 'opus'];

            const mimeMap = {
                'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png', 'gif': 'image/gif', 'webp': 'image/webp',
                'mp4': 'video/mp4', 'mov': 'video/quicktime', 'avi': 'video/x-msvideo',
                'mp3': 'audio/mpeg', 'ogg': 'audio/ogg', 'wav': 'audio/wav', 'opus': 'audio/opus'
            };

            let message;
            const finalCaption = caption || filename;

            if (imageExts.includes(ext)) {
                message = { image: fileBuffer, caption: finalCaption, mimetype: mimeMap[ext] || 'image/jpeg' };
            } else if (videoExts.includes(ext)) {
                message = { video: fileBuffer, caption: finalCaption, mimetype: mimeMap[ext] || 'video/mp4' };
            } else if (audioExts.includes(ext)) {
                message = { audio: fileBuffer, mimetype: mimeMap[ext] || 'audio/mpeg', ptt: false };
            } else {
                const docMimeMap = { 'pdf': 'application/pdf', 'doc': 'application/msword', 'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'xls': 'application/vnd.ms-excel', 'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'zip': 'application/zip', 'txt': 'text/plain', 'csv': 'text/csv' };
                message = { document: fileBuffer, fileName: filename, caption: finalCaption, mimetype: docMimeMap[ext] || 'application/octet-stream' };
            }

            return await session.socket.sendMessage(formattedNumber, message);
        };

        if (wait) {
            try {
                const result = await sendBase64Fn();
                return res.json({
                    success: true,
                    status: 'sent',
                    messageId: result?.key?.id,
                    to: to,
                    timestamp: new Date().toISOString()
                });
            } catch (error) {
                const statusCode = (error.code === 'invalid_number' || error.message.includes('not registered')) ? 400 : 500;
                return res.status(statusCode).json({
                    success: false,
                    status: 'error',
                    error: error.code || 'unknown_error',
                    message: error.message,
                    timestamp: new Date().toISOString()
                });
            }
        } else {
            setImmediate(async () => {
                try {
                    await sendBase64Fn();
                } catch (err) {
                    log('error', `❌ [BASE64_FILE_ASYNC] Background failure: ${err.message}`);
                }
            });

            return res.status(202).json({
                success: true,
                status: 'accepted',
                messageId: `pending_base64_${Date.now()}`,
                note: 'Base64 file accepted'
            });
        }
    } catch (err) {
        log('error', `❌ [BASE64_FILE_ENDPOINT_CRASH] ${err.message}`, err);
        return res.status(500).json({ success: false, error: 'internal_error', message: err.message });
    }
});

// Send group message
app.post('/session/:deviceId/group-message', async (req, res) => {
    const { deviceId } = req.params;
    const { group_name, message } = req.body;

    log('info', `📤 [GROUP_MESSAGE_ENDPOINT] Received group message send request`);
    log('info', `📤 [GROUP_MESSAGE_ENDPOINT] Device: ${deviceId}, Group: ${group_name}`);
    log('info', `📤 [GROUP_MESSAGE_ENDPOINT] Message: ${message}`);
    log('info', `📤 [GROUP_MESSAGE_ENDPOINT] Request body keys: ${Object.keys(req.body)}`);

    // Always return a response immediately
    const immediateResponse = (status, data, statusCode = 200) => {
        log('info', `📤 [GROUP_MESSAGE_ENDPOINT] Sending response: ${status}, status: ${statusCode}`);
        if (status === 'error') {
            return res.status(statusCode).json({
                success: false,
                error: data.error,
                message: data.message,
                timestamp: new Date().toISOString()
            });
        } else {
            return res.status(statusCode).json({
                success: true,
                result: data,
                timestamp: new Date().toISOString()
            });
        }
    };

    // Validation
    if (!group_name || !message) {
        log('error', `❌ [GROUP_MESSAGE_ENDPOINT] Missing parameters - group_name: ${!!group_name}, message: ${!!message}`);
        return immediateResponse('error', {
            error: 'missing_parameters',
            message: 'Both "group_name" and "message" are required'
        }, 400);
    }

    const session = sessions.get(deviceId);
    if (!session) {
        log('error', `❌ [GROUP_MESSAGE_ENDPOINT] Session not found for device: ${deviceId}`);
        return immediateResponse('error', {
            error: 'device_not_found',
            message: 'Device session not found'
        }, 404);
    }

    if (session.status !== 'connected') {
        log('error', `❌ [GROUP_MESSAGE_ENDPOINT] Device not connected - status: ${session.status}`);
        return immediateResponse('error', {
            error: 'device_not_active',
            message: 'Device is not connected'
        }, 400);
    }

    try {
        log('info', `📤 [GROUP_MESSAGE_ENDPOINT] Starting group message send process`);

        // Try different methods to get chats
        let chats = [];

        // Method 1: Try to get from store
        if (session.socket.store && session.socket.store.chats) {
            chats = Array.from(session.socket.store.chats.values());
            log('info', `📤 [GROUP_MESSAGE_ENDPOINT] Found ${chats.length} chats from store`);
        } else {
            // Method 2: Try to fetch chats directly
            try {
                const fetchedChats = await session.socket.fetchChats();
                chats = fetchedChats;
                log('info', `📤 [GROUP_MESSAGE_ENDPOINT] Found ${chats.length} chats from fetchChats`);
            } catch (fetchError) {
                log('warn', `⚠️ [GROUP_MESSAGE_ENDPOINT] fetchChats failed: ${fetchError.message}`);

                // Method 3: Use a simple approach - try to send directly by group ID
                log('info', `📤 [GROUP_MESSAGE_ENDPOINT] Trying direct group ID approach`);

                // Try common group ID formats
                const possibleGroupIds = [
                    group_name,
                    `${group_name}@g.us`,
                    `918767647149-${group_name}@g.us`
                ];

                for (const groupId of possibleGroupIds) {
                    try {
                        log('info', `📤 [GROUP_MESSAGE_ENDPOINT] Trying group ID: ${groupId}`);
                        await session.socket.sendMessage(groupId, { text: message });

                        log('info', `✅ [GROUP_MESSAGE_ENDPOINT] Group message sent successfully to '${group_name}' using ID: ${groupId}`);

                        return immediateResponse('success', {
                            status: 'sent',
                            message: 'Group message sent successfully',
                            group_name: group_name,
                            group_id: groupId,
                            message: message,
                            timestamp: new Date().toISOString()
                        });
                    } catch (sendError) {
                        log('info', `📤 [GROUP_MESSAGE_ENDPOINT] Group ID ${groupId} failed: ${sendError.message}`);
                        continue;
                    }
                }

                // If all direct attempts failed
                log('error', `❌ [GROUP_MESSAGE_ENDPOINT] All group ID attempts failed for '${group_name}'`);
                return immediateResponse('error', {
                    error: 'group_not_found',
                    message: `Group '${group_name}' not found. Tried: ${possibleGroupIds.join(', ')}`
                }, 404);
            }
        }

        if (chats.length === 0) {
            log('error', `❌ [GROUP_MESSAGE_ENDPOINT] No chats found`);
            return immediateResponse('error', {
                error: 'no_chats',
                message: 'No chats available. Please wait for chats to load or try again.'
            }, 400);
        }

        // Find the group by name
        let targetGroup = null;
        for (const chat of chats) {
            // Check if it's a group and matches the name
            if (chat.id && chat.id.endsWith('@g.us')) {
                if (chat.name === group_name || chat.id === group_name) {
                    targetGroup = chat;
                    log('info', `📤 [GROUP_MESSAGE_ENDPOINT] Found target group: ${chat.name} (${chat.id})`);
                    break;
                }
            }
        }

        if (!targetGroup) {
            log('error', `❌ [GROUP_MESSAGE_ENDPOINT] Group '${group_name}' not found`);
            const availableGroups = chats
                .filter(c => c.id && c.id.endsWith('@g.us'))
                .map(c => c.name || c.id)
                .join(', ');

            return immediateResponse('error', {
                error: 'group_not_found',
                message: `Group '${group_name}' not found. Available groups: ${availableGroups}`
            }, 404);
        }

        // Send message to the group
        log('info', `📤 [GROUP_MESSAGE_ENDPOINT] Sending message to group: ${targetGroup.id}`);
        await session.socket.sendMessage(targetGroup.id, { text: message });

        log('info', `✅ [GROUP_MESSAGE_ENDPOINT] Group message sent successfully to '${group_name}'`);

        return immediateResponse('success', {
            status: 'sent',
            message: 'Group message sent successfully',
            group_name: group_name,
            group_id: targetGroup.id,
            message: message,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        log('error', `❌ [GROUP_MESSAGE_ENDPOINT] Error sending group message: ${error.message}`);
        log('error', `❌ [GROUP_MESSAGE_ENDPOINT] Full error stack: ${error.stack}`);
        return immediateResponse('error', {
            error: 'send_failed',
            message: `Failed to send group message: ${error.message}`
        }, 500);
    }
});

// Get all groups
app.get('/session/:deviceId/groups', async (req, res) => {
    const { deviceId } = req.params;

    log('info', `📤 [GROUPS_ENDPOINT] Received get all groups request`);
    log('info', `📤 [GROUPS_ENDPOINT] Device: ${deviceId}`);

    const session = sessions.get(deviceId);

    if (!session) {
        log('error', `Session not found for device: ${deviceId}`);
        return res.status(404).json({ 
            success: false, 
            message: 'Device session not found' 
        });
    }

    // Check if device is connected - be more lenient with connection check
    const isConnected = session.status === 'connected' ||
        (session.socket && session.socket.ws && session.socket.ws.readyState === 1);

    if (!isConnected) {
        log('error', `Device not connected - status: ${session.status}, ws state: ${session.socket?.ws?.readyState}`);
        return res.status(400).json({ 
            success: false, 
            message: 'Device is not connected' 
        });
    }

    try {
        log('info', `📤 [GROUPS_ENDPOINT] Using groupFetchAllParticipating() to fetch groups`);
        
        // Force fetch all participating groups directly from WhatsApp
        const groups = await session.socket.groupFetchAllParticipating();

        const formatted = Object.values(groups).map(g => ({
            id: g.id,
            name: g.subject || g.id,
            subject: g.subject,
            participants: g.participants ? g.participants.length : 0
        }));

        log('info', `✅ [GROUPS_ENDPOINT] Found ${formatted.length} groups using groupFetchAllParticipating()`);

        return res.json({
            success: true,
            total: formatted.length,
            groups: formatted,
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        log('error', `❌ [GROUPS_ENDPOINT] Error fetching groups: ${err.message}`);
        log('error', `❌ [GROUPS_ENDPOINT] Full error stack: ${err.stack}`);
        return res.status(500).json({ 
            success: false, 
            error: err.message 
        });
    }
});

// Get group members
app.post('/session/:deviceId/group-members', async (req, res) => {
    const { deviceId } = req.params;
    const { group_name } = req.body;

    log('info', `📤 [GROUP_MEMBERS_ENDPOINT] Received get group members request`);
    log('info', `📤 [GROUP_MEMBERS_ENDPOINT] Device: ${deviceId}, Group: ${group_name}`);

    // Always return a response immediately
    const immediateResponse = (status, data, statusCode = 200) => {
        log('info', `📤 [GROUP_MEMBERS_ENDPOINT] Sending response: ${status}, status: ${statusCode}`);
        if (status === 'error') {
            return res.status(statusCode).json({
                success: false,
                error: data.error,
                message: data.message,
                timestamp: new Date().toISOString()
            });
        } else {
            return res.status(statusCode).json({
                success: true,
                result: data,
                timestamp: new Date().toISOString()
            });
        }
    };

    // Validation
    if (!group_name) {
        log('error', `❌ [GROUP_MEMBERS_ENDPOINT] Missing group_name parameter`);
        return immediateResponse('error', {
            error: 'missing_parameters',
            message: 'Group name is required'
        }, 400);
    }

    const session = sessions.get(deviceId);
    if (!session) {
        log('error', `❌ [GROUP_MEMBERS_ENDPOINT] Session not found for device: ${deviceId}`);
        return immediateResponse('error', {
            error: 'device_not_found',
            message: 'Device session not found'
        }, 404);
    }

    if (session.status !== 'connected') {
        log('error', `❌ [GROUP_MEMBERS_ENDPOINT] Device not connected - status: ${session.status}`);
        return immediateResponse('error', {
            error: 'device_not_active',
            message: 'Device is not connected'
        }, 400);
    }

    try {
        log('info', `📤 [GROUP_MEMBERS_ENDPOINT] Starting get group members process`);

        // Get all groups using groupFetchAllParticipating (same as groups endpoint)
        const groups = await session.socket.groupFetchAllParticipating();
        
        // Find the target group by name or subject
        let targetGroup = null;
        for (const groupId in groups) {
            const group = groups[groupId];
            if (group.subject === group_name || group.id === group_name) {
                targetGroup = group;
                break;
            }
        }

        if (!targetGroup) {
            log('error', `Group '${group_name}' not found`);
            return immediateResponse('error', {
                error: 'group_not_found',
                message: `Group '${group_name}' not found`
            }, 404);
        }

        // Get group metadata
        const metadata = await session.socket.groupMetadata(targetGroup.id);

        const members = [];
        let resolved = 0;
        let unresolved = 0;
        let fallbackUsed = 0;

        for (const participant of metadata.participants) {
            let phoneNumber = null;
            let name = participant.name || participant.notify || 'Unknown';
            let memberInfo = {
                id: participant.id,
                name: name,
                phone: null,
                isAdmin: participant.admin === 'admin' || participant.admin === 'superadmin',
                isSuperAdmin: participant.admin === 'superadmin'
            };

            // Skip group IDs
            if (participant.id && participant.id.includes('@g.us')) {
                continue;
            }

            // Debug: Log participant data to understand structure
            log('info', `Processing participant: ${JSON.stringify({
                id: participant.id,
                lid: participant.lid,
                jid: participant.jid,
                number: participant.number,
                name: name
            })}`);

            // Try to get phone number using resolveParticipantToPhone functionality
            phoneNumber = resolveParticipantToPhone(participant.id);
            
            // If participant has a 'lid' field, try that too
            if (!phoneNumber && participant.lid) {
                phoneNumber = resolveParticipantToPhone(participant.lid);
            }
            
            // Check if participant has a 'number' field directly
            if (!phoneNumber && participant.number) {
                phoneNumber = participant.number.replace(/[^0-9]/g, '');
            }

            // Check 'jid' field
            if (!phoneNumber && participant.jid) {
                phoneNumber = resolveParticipantToPhone(participant.jid);
            }

            // UPDATED EXTRACTION LOGIC - Use resolved phone number
            if (phoneNumber && phoneNumber.length >= 7) {
                resolved++;
                memberInfo.phone = phoneNumber; // Store resolved number
            } else {
                unresolved++;
                // No valid phone number - skip this member
                log('info', `Skipping ${name} - no valid phone number found (LID mappings: ${Object.keys(lidToPhone).length})`);
                continue;
            }

            // Add member to list
            members.push(memberInfo);
        }

        log('info', `Phone resolution: ${resolved} resolved, ${fallbackUsed} fallback, ${unresolved} skipped`);
        log('info', `Found ${members.length} total members for group: ${group_name}`);

        log('info', `Found ${members.length} members for group: ${group_name}`);

        // Apply normalizeNumbers function to format phone numbers properly
        const normalizedMembers = normalizeNumbers(members);

        return res.json({
            success: true,
            group_id: targetGroup.id,
            group_name: targetGroup.subject,
            members: normalizedMembers,
            total: normalizedMembers.length
        });

    } catch (error) {
        log('error', `Error getting group members: ${error.message}`);
        return res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Test endpoint to verify routing
app.get('/test-export', async (req, res) => {
    console.log('TEST ENDPOINT CALLED');
    return res.json({ message: 'Test endpoint working' });
});

// Export group members to XLS
app.get('/session/:deviceId/group-export/:groupId', async (req, res) => {
    const { deviceId, groupId } = req.params;

    log('info', `=== EXPORT DEBUG START ===`);
    log('info', `📤 [GROUP_EXPORT_ENDPOINT] Received group export request`);
    log('info', `📤 [GROUP_EXPORT_ENDPOINT] Device: ${deviceId}, Group: ${groupId}`);

    const session = sessions.get(deviceId);

    if (!session || session.status !== 'connected') {
        log('error', `❌ [GROUP_EXPORT_ENDPOINT] Device not connected`);
        return res.status(400).json({ 
            success: false, 
            message: 'Device not connected' 
        });
    }

    try {
        log('info', `📤 [GROUP_EXPORT_ENDPOINT] Fetching group metadata for: ${groupId}`);
        
        const metadata = await session.socket.groupMetadata(groupId);

        console.log('=== EXPORT DEBUG ===');
        console.log('Metadata:', metadata);
        console.log('Participants:', metadata.participants);
        console.log('Participants length:', metadata.participants?.length);
        console.log('LID mappings before building:', Object.keys(lidToPhone).length);

        if (!metadata.participants || metadata.participants.length === 0) {
            console.log('NO PARTICIPANTS FOUND - returning error');
            return res.status(404).json({
                success: false,
                message: 'No participants found in group',
                debug: {
                    metadata: metadata,
                    participantsCount: metadata.participants?.length || 0,
                    lidMappings: Object.keys(lidToPhone).length
                }
            });
        }

        // Build LID mappings manually from participants since contact events are not firing
        console.log('Building LID mappings from participants...');
        for (const participant of metadata.participants) {
            processContact(participant);
        }
        console.log('LID mappings after building:', Object.keys(lidToPhone).length);

        const contacts = [];
        let resolved = 0;
        let unresolved = 0;
        let fallbackUsed = 0;

        // Process each participant directly from metadata
        for (let i = 0; i < metadata.participants.length; i++) {
            const participant = metadata.participants[i];
            let phoneNumber = null;
            let name = participant.name || participant.notify || 'Unknown';
            
            log('info', `=== PROCESSING PARTICIPANT ${i} ===`);
            log('info', `Participant data: ${JSON.stringify(participant)}`);
            
            // Extract phone number directly from phoneNumber field
            if (participant.phoneNumber) {
                phoneNumber = participant.phoneNumber.split('@')[0].split(':')[0];
                log('info', `SUCCESS: Extracted phone from phoneNumber field: ${phoneNumber}`);
            } else {
                log('info', `No phoneNumber field found for participant ${i}`);
            }
            
            // Create contact info
            let contactInfo = {
                name: name,
                phone: phoneNumber,
                isAdmin: participant.admin === 'admin' || participant.admin === 'superadmin',
                isSuperAdmin: participant.admin === 'superadmin'
            };

            // Skip group IDs
            if (participant.id && participant.id.includes('@g.us')) {
                log('info', `Skipping group ID: ${participant.id}`);
                continue;
            }

            // Check if we have a valid phone number
            if (phoneNumber && phoneNumber.length >= 7) {
                resolved++;
                log('info', `SUCCESS: Added ${name} with phone ${phoneNumber}`);
                contacts.push(contactInfo);
            } else {
                unresolved++;
                log('info', `Skipping ${name} - no valid phone number found`);
                continue;
            }
        }

        log('info', `Export phone resolution: ${resolved} resolved, ${unresolved} skipped`);
        log('info', `Found ${contacts.length} total contacts for export`);

        log('info', `Found ${contacts.length} contacts for export`);
        log('info', `Current LID mappings count: ${Object.keys(lidToPhone).length}`);
        log('info', `LID mappings sample: ${JSON.stringify(Object.entries(lidToPhone).slice(0, 3))}`);

        // PART 3: SAFETY VALIDATION - More permissive
        const cleanContacts = contacts.filter(c =>
            c.phone && c.phone.length >= 7
        );
        
        log('info', `Clean contacts after filtering: ${cleanContacts.length}`);

        if (cleanContacts.length === 0) {
            log('info', 'No valid contacts to export');
            return res.status(404).json({
                success: false,
                message: 'No valid contacts found for export'
            });
        }

        // Apply normalizeNumbers function to format phone numbers properly
        const normalizedContacts = normalizeNumbers(cleanContacts);

        // Prepare data for Excel with proper column names
        const wsData = normalizedContacts.map(c => ({
            Name: c.name || 'Unknown',
            Phone: c.phone,   // properly formatted with + prefix
            Group: metadata.subject || 'Unknown'
        }));

        const worksheet = XLSX.utils.json_to_sheet(wsData);

        // Force text format for phone column (column B) to prevent scientific notation
        Object.keys(worksheet).forEach(cell => {
            if (cell.startsWith('B')) { // Phone column is B
                worksheet[cell].t = 's'; // string type
                worksheet[cell].w = worksheet[cell].v; // ensure string value
            }
        });

        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, "Contacts");

        // Create exports directory if it doesn't exist
        const exportsDir = path.join(__dirname, 'exports');
        if (!fs.existsSync(exportsDir)) {
            fs.mkdirSync(exportsDir, { recursive: true });
        }

        const filePath = path.join(exportsDir, `${groupId}_contacts.xlsx`);
        XLSX.writeFile(workbook, filePath);

        log('info', `✅ [GROUP_EXPORT_ENDPOINT] XLS file created: ${filePath}`);

        res.download(filePath, `${groupId}_contacts.xlsx`, (err) => {
            if (err) {
                log('error', `❌ [GROUP_EXPORT_ENDPOINT] Error sending file: ${err.message}`);
            }
            // Clean up file after download
            try {
                fs.unlinkSync(filePath);
            } catch (e) {
                log('warn', `⚠️ [GROUP_EXPORT_ENDPOINT] Failed to delete file: ${e.message}`);
            }
        });
    } catch (err) {
        log('error', `❌ [GROUP_EXPORT_ENDPOINT] Error exporting group: ${err.message}`);
        log('error', `❌ [GROUP_EXPORT_ENDPOINT] Full error stack: ${err.stack}`);
        return res.status(500).json({ 
            success: false, 
            error: err.message 
        });
    }
});

// Check message status
app.get('/session/:deviceId/message/:messageId/status', (req, res) => {
    const { deviceId, messageId } = req.params;

    const session = sessions.get(deviceId);
    if (!session) {
        return res.status(404).json({
            error: 'device_not_found',
            message: 'Device session not found'
        });
    }

    if (!session.messageStatus || !session.messageStatus.has(messageId)) {
        return res.status(404).json({
            error: 'message_not_found',
            message: 'Message status not found'
        });
    }

    const status = session.messageStatus.get(messageId);
    res.json({
        messageId,
        deviceId,
        ...status,
        timestamp: new Date().toISOString()
    });
});

// Reconnect device
app.post('/session/:deviceId/reconnect', async (req, res) => {
    const { deviceId } = req.params;

    log('info', `Manual reconnect requested for: ${deviceId}`);

    const oldSession = sessions.get(deviceId);
    if (oldSession?.socket) {
        try {
            oldSession.socket.ev.removeAllListeners();
            oldSession.socket.end(undefined);
        } catch (e) {
            log('warn', `Error closing old socket for ${deviceId}`, e);
        }
    }

    sessions.delete(deviceId);
    qrCache.delete(deviceId);
    connectionPromises.delete(deviceId);

    try {
        await initSession(deviceId);
        res.json({
            status: 'reconnecting',
            deviceId,
            message: 'Reconnection initiated'
        });
    } catch (error) {
        log('error', `Failed to start reconnection for ${deviceId}`, error);
        res.status(500).json({
            status: 'error',
            message: 'Reconnection failed'
        });
    }
});

// Delete session
app.delete('/session/:deviceId', async (req, res) => {
    const { deviceId } = req.params;

    log('info', `Session deletion requested for: ${deviceId}`);

    try {
        const session = sessions.get(deviceId);

        if (session && session.socket) {
            // Close WhatsApp connection
            await session.socket.logout();
            session.socket.end();
        }

        // Clean up session data
        sessions.delete(deviceId);
        qrCache.delete(deviceId);
        connectionPromises.delete(deviceId);

        // Delete session directory
        try {
            fs.rmSync(path.join(SESSION_DIR, deviceId), { recursive: true, force: true });
            log('info', `Session directory deleted for: ${deviceId}`);
        } catch (e) {
            log('warn', `Failed to delete session dir for ${deviceId}`, e);
        }

        res.json({
            status: 'deleted',
            deviceId,
            message: 'Session deleted successfully'
        });

    } catch (error) {
        log('error', `Failed to delete session for ${deviceId}`, error);
        res.status(500).json({
            status: 'error',
            message: 'Session deletion failed'
        });
    }
});

// Create group
app.post('/session/:deviceId/create-group', async (req, res) => {
    const { deviceId } = req.params;
    const { group_name, description } = req.body;

    log('info', `📥 [CREATE_GROUP] Creating group '${group_name}' from device ${deviceId}`);

    // Validation
    if (!group_name) {
        return res.status(400).json({
            success: false,
            error: 'missing_parameters',
            message: 'Group name is required'
        });
    }

    const session = sessions.get(deviceId);
    if (!session) {
        return res.status(404).json({
            success: false,
            error: 'device_not_found',
            message: 'Device session not found'
        });
    }

    if (session.status !== 'connected') {
        return res.status(400).json({
            success: false,
            error: 'device_not_connected',
            status: session.status,
            message: 'Device is not connected'
        });
    }

    try {
        log('info', `📥 [CREATE_GROUP] Creating group with name: ${group_name}`);

        // Create group using Baileys group creation
        const groupMetadata = await session.socket.groupCreate(group_name, []);

        log('info', `✅ [CREATE_GROUP] Group created successfully: '${group_name}'`);

        return res.json({
            success: true,
            result: {
                groupId: groupMetadata.id,
                subject: groupMetadata.subject,
                owner: groupMetadata.owner,
                creation: groupMetadata.creation,
                participants: groupMetadata.participants
            },
            message: `Group '${group_name}' created successfully`
        });

    } catch (error) {
        log('error', `❌ [CREATE_GROUP] Failed to create group: ${error.message}`);
        return res.status(500).json({
            success: false,
            error: 'group_creation_failed',
            message: `Failed to create group: ${error.message}`
        });
    }
});

// Add contacts to group
app.post('/session/:deviceId/group/:groupId/contacts', async (req, res) => {
    const { deviceId, groupId } = req.params;
    const { contacts } = req.body.request || {};

    log('info', `📥 [GROUP_CONTACTS_ENDPOINT] Adding ${contacts.length} contacts to group ${groupId} from device ${deviceId}`);

    // Validation
    if (!contacts || !Array.isArray(contacts) || contacts.length === 0) {
        return res.status(400).json({
            success: false,
            error: 'missing_contacts',
            message: 'Contacts array is required'
        });
    }

    const session = sessions.get(deviceId);
    if (!session) {
        return res.status(404).json({
            success: false,
            error: 'device_not_found',
            message: 'Device session not found'
        });
    }

    if (session.status !== 'connected') {
        return res.status(400).json({
            success: false,
            error: 'device_not_connected',
            status: session.status,
            message: 'Device is not connected'
        });
    }

    try {
        log('info', `📥 [GROUP_CONTACTS_ENDPOINT] Starting to add ${contacts.length} contacts to group ${groupId}`);

        const addedContacts = [];
        let successCount = 0;
        let failCount = 0;

        for (const contact of contacts) {
            try {
                const phoneNumber = contact.phone.includes('@s.whatsapp.net')
                    ? contact.phone
                    : `${contact.phone.replace(/\D/g, '')}@s.whatsapp.net`;

                log('info', `📥 [GROUP_CONTACTS_ENDPOINT] Adding ${contact.name} (${phoneNumber}) to group ${groupId}`);

                // Add participant to group using Baileys (try groupAdd first)
                let result;
                try {
                    result = await session.socket.groupParticipantsUpdate(
                        groupId,
                        [phoneNumber]
                    );
                    log('info', `📥 [GROUP_CONTACTS_ENDPOINT] Added ${contact.name} using groupParticipantsUpdate`);
                } catch (groupError) {
                    log('error', `❌ [GROUP_CONTACTS_ENDPOINT] Group operation failed: ${groupError.message}`);
                    result = null;
                }

                if (result) {
                    addedContacts.push({
                        name: contact.name,
                        phone: contact.phone,
                        group_id: groupId,
                        status: 'added'
                    });
                    successCount++;
                    log('info', `✅ [GROUP_CONTACTS_ENDPOINT] Successfully added ${contact.name} to group`);
                } else {
                    addedContacts.push({
                        name: contact.name,
                        phone: contact.phone,
                        group_id: groupId,
                        status: 'failed'
                    });
                    failCount++;
                    log('error', `❌ [GROUP_CONTACTS_ENDPOINT] Failed to add ${contact.name} to group`);
                }

                // Add delay to avoid rate limiting
                await new Promise(resolve => setTimeout(resolve, 1000));

            } catch (error) {
                addedContacts.push({
                    name: contact.name,
                    phone: contact.phone,
                    group_id: groupId,
                    status: 'failed',
                    error: error.message
                });
                failCount++;
                log('error', `❌ [GROUP_CONTACTS_ENDPOINT] Error adding ${contact.name}: ${error.message}`);
            }
        }

        log('info', `✅ [GROUP_CONTACTS_ENDPOINT] Completed: ${successCount} added, ${failCount} failed`);

        return res.json({
            success: true,
            added_count: successCount,
            failed_count: failCount,
            contacts: addedContacts,
            device_id: deviceId,
            message: `Added ${successCount} contacts to group successfully`
        });

    } catch (error) {
        log('error', `❌ [GROUP_CONTACTS_ENDPOINT] Error adding contacts to group: ${error.message}`);
        return res.status(500).json({
            success: false,
            error: 'group_contact_addition_failed',
            message: `Failed to add contacts to group: ${error.message}`
        });
    }
});

/* =========================
   FRONTEND API ROUTES (Proxy)
========================= */

// Proxy any other requests to Next.js development server if available
// Diagnostic: Dump all in-memory sessions
app.get('/debug/sessions', (req, res) => {
    const data = [...sessions.entries()].map(([id, s]) => ({
        id: id,
        status: s.status,
        device_name: s.device_name || 'unknown',
        has_socket: !!s.socket,
        socket_is_open: s.socket ? (typeof s.socket.ws?.isOpen === 'function' ? s.socket.ws.isOpen() : true) : false
    }));
    res.json({
        total: sessions.size,
        engine_initialized: isEngineInitialized,
        uptime: process.uptime(),
        sessions: data
    });
});

// 🔥 GLOBAL 404 HANDLER (JSON ONLY)
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: 'not_found',
        message: `Endpoint ${req.method} ${req.url} not found`
    });
});

// 🔥 GLOBAL ERROR HANDLER
app.use((err, req, res, next) => {
    log('error', `🔥 UNHANDLED ERROR in ${req.method} ${req.url}`, {
        message: err.message,
        stack: err.stack
    });
    
    // Ensure we don't try to send a response if one has already been sent
    if (res.headersSent) {
        return next(err);
    }
    
    res.status(500).json({
        success: false,
        error: 'internal_server_error',
        message: err.message || 'An unexpected error occurred'
    });
});

/**
 * Checks if backend is available before proceeding
 */
async function waitForBackend(maxRetries = 10) {
    const backendUrl = process.env.BACKEND_URL || 'http://127.0.0.1:8000';
    for (let i = 0; i < maxRetries; i++) {
        try {
            log('info', `🔍 [${i + 1}/${maxRetries}] Checking backend availability at ${backendUrl}/health...`);
            await axios.get(`${backendUrl}/health`, { timeout: 3000 });
            log('info', `✅ Backend is UP and reachable.`);
            return true;
        } catch (err) {
            log('warn', `⚠️ Backend unreachable (${err.message}). Retrying in 5s...`);
            await new Promise(r => setTimeout(r, 5000));
        }
    }
    log('error', `🛑 Backend still unreachable after ${maxRetries} attempts. Proceeding with caution.`);
    return false;
}

/* =========================
   STARTUP & INITIALIZATION
   ========================= */
async function startServer() {
    try {
        // Load baileys first
        await loadBaileys();

        // Ensure sessions directory exists
        if (!fs.existsSync(SESSION_DIR)) {
            fs.mkdirSync(SESSION_DIR, { recursive: true });
            log('info', `Created sessions directory: ${SESSION_DIR}`);
        }

        // Start Express server
        const server = app.listen(WHATSAPP_ENGINE_PORT, '0.0.0.0', async () => {
            log('info', `🚀 WhatsApp Engine Server STARTED`);
            log('info', `📡 Engine running on port ${WHATSAPP_ENGINE_PORT}`);
            log('info', `📱 WhatsApp Engine initialized`);

            // Check if backend is available before restoring sessions
            await waitForBackend(12); // Increased from 5 to 12 retries (60 seconds total)

            // Mark engine as initialized
            isEngineInitialized = true;

            // 🔥 Start heartbeat monitor for connection health
            startHeartbeat();

            // Restore existing sessions
            restoreSessions();
        });

        // Handle server errors
        server.on('error', (error) => {
            log('error', '❌ Server error:', error);
            if (error.code === 'EADDRINUSE') {
                log('error', `❌ Port ${WHATSAPP_ENGINE_PORT} is already in use`);
            } else if (error.code === 'EACCES') {
                log('error', `❌ Permission denied for port ${WHATSAPP_ENGINE_PORT}`);
            }
            process.exit(1);
        });

        // Log engine status every 5 minutes
        setInterval(() => {
            let connectedCount = 0;
            let qrReadyCount = 0;
            
            for (const session of sessions.values()) {
                if (session.status === 'connected') connectedCount++;
                else if (session.status === 'qr_ready') qrReadyCount++;
            }

            log('info', '📊 Engine Status Check', {
                sessions: sessions.size,
                connected: connectedCount,
                qr_ready: qrReadyCount,
                uptime: process.uptime(),
            });
        }, 300000);

    } catch (error) {
        log('error', 'Failed to start server', error);
        process.exit(1);
    }
}

// Start the server
startServer();

// Graceful shutdown
process.on('SIGINT', () => {
    log('info', '🛑 SIGINT received - shutting down gracefully');
    stopHeartbeat();
    process.exit(0);
});

process.on('SIGTERM', () => {
    log('info', '🛑 SIGTERM received - shutting down gracefully');
    stopHeartbeat();
    process.exit(0);
});
