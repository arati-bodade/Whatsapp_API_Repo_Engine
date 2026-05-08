# WhatsApp Engine

## Description
Standalone WhatsApp Engine service for handling WhatsApp connections and QR generation.

## Installation
```bash
npm install
```

## Usage
```bash
# Start WhatsApp Engine
npm start

# Or for development
npm run dev
```

## Render Deployment

This service includes a `render.yaml` configuration file for easy deployment on Render.

### Deployment Steps

1. Push this code to GitHub
2. Go to [render.com](https://render.com)
3. Click "New +" → "Web Service"
4. Connect your GitHub repository
5. Select this directory (`whatsapp-platform-api-engine`)
6. Configure:
   - **Name**: whatsapp-platform-api-engine
   - **Region**: Oregon (or closest to users)
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free
7. Set environment variables (optional):
   - `PORT=10000`
   - `NODE_ENV=production`
8. Advanced Settings:
   - **Health Check Path**: `/health`
   - **Auto-Deploy**: Disable (recommended)

### Verification

After deployment, verify the service is running:
```bash
curl https://whatsapp-platform-api-engine.onrender.com/health
```

Should return:
```json
{
  "status": "ok",
  "engine": "running",
  "port": 10000,
  ...
}
```

## API Endpoints
- `GET /health` - Health check
- `GET /session/{deviceId}/qr` - Get QR code
- `POST /session/{deviceId}/logout` - Logout device
- `POST /session/{deviceId}/message` - Send message
- `DELETE /session/{deviceId}` - Delete session

## Default Port
- **Local**: 3002
- **Render**: 10000 (via PORT env var)

## Dependencies
- @whiskeysockets/baileys
- express
- cors
- qrcode
- dotenv
- axios

## Features
- QR code generation
- Session management
- WhatsApp connection handling
- Health monitoring
- Auto-reconnection
- Persistent sessions
