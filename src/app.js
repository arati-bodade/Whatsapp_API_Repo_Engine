/**
 * WhatsApp Engine - Main Application
 * Complete WhatsApp Engine Architecture
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

// Import routes
const sessionRoutes = require('./controllers/sessionController');
const healthRoutes = require('./controllers/healthController');
const webhookRoutes = require('./controllers/webhookController');

// Import middleware
const errorHandler = require('./middleware/errorHandler');
const logger = require('./utils/logger');
const { initializeEngine } = require('./services/engineService');

const app = express();
const PORT = process.env.PORT || 3002;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(logger.requestLogger);

// Routes
app.use('/session', sessionRoutes);
app.use('/health', healthRoutes);
app.use('/webhooks', webhookRoutes);

// Static files for sessions
app.use('/whatsapp_sessions', express.static(path.join(__dirname, '../whatsapp_sessions')));

// Error handling
app.use(errorHandler);

// Initialize WhatsApp Engine
initializeEngine();

// Start server
app.listen(PORT, () => {
    console.log(`🚀 WhatsApp Engine Server STARTED`);
    console.log(`📡 Engine running on port ${PORT}`);
    console.log(`📱 WhatsApp Engine initialized`);
    console.log(`🌐 Health check: http://localhost:${PORT}/health`);
});

module.exports = app;
