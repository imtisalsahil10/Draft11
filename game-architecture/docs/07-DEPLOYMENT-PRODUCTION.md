# Deployment, Configuration & Production Guide

## 1. ENVIRONMENT SETUP

### Backend (.env.example → .env)
```env
# Server
PORT=3001
NODE_ENV=production
LOG_LEVEL=info

# Database
MONGODB_URI=mongodb+srv://user:password@cluster.mongodb.net/football-auction
MONGODB_TIMEOUT=10000

# Socket.IO
SOCKET_IO_CORS=https://yourdomain.com
SOCKET_IO_PING_INTERVAL=25000
SOCKET_IO_PING_TIMEOUT=60000

# Security
JWT_SECRET=your_jwt_secret_here
RATE_LIMIT_WINDOW=900000
RATE_LIMIT_MAX=100

# Logging
LOG_DIR=./logs
```

### Frontend (.env.example → .env)
```env
# Development
VITE_API_URL=http://localhost:3001
VITE_SOCKET_URL=http://localhost:3001
VITE_ENV=development

# Production
# VITE_API_URL=https://api.yourdomain.com
# VITE_SOCKET_URL=https://yourdomain.com
```

---

## 2. DATABASE SETUP (MongoDB Atlas)

### Step 1: Create MongoDB Atlas Account
1. Go to mongodb.com/cloud/atlas
2. Create free tier cluster
3. Create database user (username/password)
4. Add IP whitelist (0.0.0.0/0 for dev, specific IPs for prod)
5. Get connection string

### Step 2: Initialize Database
```bash
# Connect to MongoDB
mongo "mongodb+srv://user:pass@cluster.mongodb.net/football-auction"

# Run seed script
node backend/scripts/seedDatabase.js
```

### Step 3: Create Indexes
```bash
# Run from MongoDB shell or use backend startup
node backend/scripts/createIndexes.js
```

**backend/scripts/seedDatabase.js**
```javascript
const mongoose = require('mongoose');
const Card = require('../src/models/Card');

async function seedCards() {
  await mongoose.connect(process.env.MONGODB_URI);

  // Clear existing cards
  await Card.deleteMany({});

  const cards = [
    // Basic cards (60 total)
    {
      cardId: 'card_001',
      name: 'Generic Striker 1',
      position: 'ST',
      stats: { pace: 75, shooting: 76, passing: 70, defense: 30, physical: 75, overall: 75 },
      category: 'Basic',
      basePrice: 10
    },
    // ... 59 more basic cards

    // Rare cards (30 total)
    {
      cardId: 'card_061',
      name: 'Elite Midfielder',
      position: 'CM',
      stats: { pace: 85, shooting: 80, passing: 87, defense: 78, physical: 82, overall: 83 },
      category: 'Rare',
      basePrice: 15
    },
    // ... 29 more rare cards

    // Legendary cards (10 total)
    {
      cardId: 'card_091',
      name: 'Haaland',
      position: 'ST',
      stats: { pace: 92, shooting: 89, passing: 81, defense: 45, physical: 87, overall: 88 },
      category: 'Legendary',
      basePrice: 25
    }
    // ... 9 more legendary cards
  ];

  await Card.insertMany(cards);
  console.log('Seeded 100 cards');
  process.exit(0);
}

seedCards().catch(err => {
  console.error(err);
  process.exit(1);
});
```

---

## 3. BUILD & DEPLOYMENT

### Backend Deployment (Railway/Heroku)

**package.json scripts**
```json
{
  "scripts": {
    "start": "node src/server.js",
    "dev": "nodemon src/server.js",
    "build": "echo 'No build needed for Node.js backend'",
    "seed": "node scripts/seedDatabase.js",
    "test": "jest"
  }
}
```

**Procfile** (for Heroku)
```
web: npm start
```

**Deploy steps**
```bash
# 1. Login to Railway/Heroku
heroku login

# 2. Create app
heroku create your-app-name

# 3. Set environment variables
heroku config:set MONGODB_URI="mongodb+srv://..."
heroku config:set NODE_ENV=production

# 4. Deploy
git push heroku main

# 5. Run seed script
heroku run npm run seed
```

### Frontend Deployment (Vercel/Netlify)

**Vercel deployment**
```bash
# 1. Install Vercel CLI
npm i -g vercel

# 2. Deploy
cd frontend
vercel

# 3. Set environment variables in Vercel dashboard
VITE_API_URL=https://your-backend.herokuapp.com
VITE_SOCKET_URL=https://your-backend.herokuapp.com
```

**Netlify deployment**
```bash
# 1. Install Netlify CLI
npm install -g netlify-cli

# 2. Build
npm run build

# 3. Deploy
netlify deploy --prod --dir=dist

# 4. Set environment variables in Netlify UI
```

---

## 4. DOCKER SETUP

### Backend Dockerfile

```dockerfile
# Dockerfile - Backend

FROM node:18-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy source
COPY src/ ./src/
COPY scripts/ ./scripts/

# Expose port
EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3001/api/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

# Start
CMD ["npm", "start"]
```

### Frontend Dockerfile

```dockerfile
# Dockerfile - Frontend

FROM node:18-alpine AS build

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Production image
FROM nginx:alpine

COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/nginx.conf

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
```

### Docker Compose

```yaml
version: '3.8'

services:
  mongodb:
    image: mongo:6
    container_name: football-auction-db
    ports:
      - "27017:27017"
    volumes:
      - mongo-data:/data/db
    environment:
      MONGO_INITDB_ROOT_USERNAME: admin
      MONGO_INITDB_ROOT_PASSWORD: password
    networks:
      - app-network

  backend:
    build:
      context: ./backend
      dockerfile: Dockerfile
    container_name: football-auction-api
    ports:
      - "3001:3001"
    environment:
      MONGODB_URI: mongodb://admin:password@mongodb:27017/football-auction?authSource=admin
      NODE_ENV: production
      SOCKET_IO_CORS: http://localhost:5173
    depends_on:
      - mongodb
    networks:
      - app-network

  frontend:
    build:
      context: ./frontend
      dockerfile: Dockerfile
    container_name: football-auction-web
    ports:
      - "80:80"
    depends_on:
      - backend
    networks:
      - app-network

volumes:
  mongo-data:

networks:
  app-network:
    driver: bridge
```

**Run with Docker Compose**
```bash
docker-compose up -d

# Check logs
docker-compose logs -f backend
docker-compose logs -f frontend

# Stop
docker-compose down
```

---

## 5. NGINX CONFIGURATION

### frontend/nginx.conf

```nginx
http {
  include /etc/nginx/mime.types;
  default_type application/octet-stream;

  upstream backend {
    server backend:3001;
  }

  server {
    listen 80;
    server_name _;

    # Serve static frontend files
    root /usr/share/nginx/html;

    # SPA routing - redirect unknown paths to index.html
    location / {
      try_files $uri $uri/ /index.html;
    }

    # API proxy
    location /api {
      proxy_pass http://backend;
      proxy_set_header Host $host;
      proxy_set_header X-Real-IP $remote_addr;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    # Socket.IO proxy
    location /socket.io {
      proxy_pass http://backend;
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "upgrade";
      proxy_set_header Host $host;
      proxy_set_header X-Real-IP $remote_addr;
    }

    # Gzip compression
    gzip on;
    gzip_types text/plain text/css application/json application/javascript;
  }
}

events {
  worker_connections 1024;
}
```

---

## 6. SECURITY CHECKLIST

```markdown
## SSL/TLS
- [ ] Enable HTTPS on all endpoints
- [ ] Use Let's Encrypt certificates
- [ ] Redirect HTTP → HTTPS
- [ ] Enable HSTS header

## Authentication & Authorization
- [ ] Validate all socket events server-side
- [ ] Check user belongs to room before allowing action
- [ ] Use JWT for REST API auth (future)
- [ ] No sensitive data in client logs

## Input Validation
- [ ] Validate room code format (alphanumeric)
- [ ] Validate username length (2-20 chars)
- [ ] Validate bid amounts (positive integers)
- [ ] Sanitize all user inputs

## CORS
- [ ] Whitelist specific origins (not *)
- [ ] Only allow necessary HTTP methods
- [ ] Set credentials policy appropriately

## Rate Limiting
- [ ] Implement rate limiting on API endpoints
- [ ] Implement per-socket rate limiting
- [ ] Prevent bid spam (max 1 bid per 100ms per player)

## Database
- [ ] Use connection pooling
- [ ] Enable MongoDB auth
- [ ] Regular backups
- [ ] Encrypt sensitive fields

## Monitoring
- [ ] Log all socket connections/disconnections
- [ ] Monitor server memory usage
- [ ] Alert on unusual auction activity
- [ ] Track API response times
```

---

## 7. PERFORMANCE OPTIMIZATION

### Backend Optimization

```javascript
// Caching strategy
const redis = require('redis');
const client = redis.createClient();

// Cache card deck (valid for 1 hour)
async function getCachedCardDeck() {
  const cached = await client.get('card_deck');
  if (cached) return JSON.parse(cached);

  const cards = await Card.find();
  await client.setex('card_deck', 3600, JSON.stringify(cards));
  return cards;
}

// Batch room cleanup every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of RoomManager.rooms.entries()) {
    // Delete room if empty for > 30 minutes
    if (room.players.size === 0 && (now - room.createdAt) > 30 * 60000) {
      RoomManager.deleteRoom(code);
    }
  }
}, 5 * 60000);
```

### Frontend Optimization

```typescript
// Code splitting
const GameRoom = React.lazy(() => import('./pages/GameRoom'));
const Leaderboard = React.lazy(() => import('./pages/Leaderboard'));

<Suspense fallback={<Loading />}>
  <Routes>
    <Route path="/room/:roomCode" element={<GameRoom />} />
    <Route path="/leaderboard" element={<Leaderboard />} />
  </Routes>
</Suspense>

// Image optimization
<img src="/cards/card_001.svg" loading="lazy" alt="Player Card" />

// Event debouncing for bid input
const debouncedBid = useMemo(
  () => debounce((amount) => emitBid(amount), 300),
  []
);
```

---

## 8. MONITORING & LOGGING

### Backend Logging Setup

```javascript
const winston = require('winston');

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.json(),
  defaultMeta: { service: 'football-auction-api' },
  transports: [
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' })
  ]
});

if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.simple()
  }));
}

// Usage
logger.info('Room created', { roomCode: 'ABC123', playerCount: 2 });
logger.error('Bid validation failed', { error: 'INSUFFICIENT_FUNDS' });
```

### Monitoring with PM2

```bash
# Install PM2
npm install -g pm2

# Start with PM2
pm2 start src/server.js --name "football-auction-api"

# Enable monitoring
pm2 monit

# Save for restart on reboot
pm2 startup
pm2 save
```

---

## 9. TESTING BEFORE PRODUCTION

### Smoke Tests

```bash
# 1. Test API health
curl http://localhost:3001/api/health

# 2. Test room creation
curl -X POST http://localhost:3001/api/rooms/create \
  -H "Content-Type: application/json" \
  -d '{
    "roomCode": "TEST1",
    "username": "testuser",
    "createdBy": "user_1"
  }'

# 3. Test Socket.IO connection
node scripts/testSocket.js

# 4. Test database
node scripts/testDatabase.js
```

### Load Testing

```bash
# Install k6
brew install k6

# Run load test
k6 run scripts/loadtest.js
```

**scripts/loadtest.js**
```javascript
import http from 'k6/http';
import { sleep } from 'k6';

export const options = {
  stages: [
    { duration: '2m', target: 100 },   // Ramp up
    { duration: '5m', target: 100 },   // Hold
    { duration: '2m', target: 0 },     // Ramp down
  ],
};

export default function () {
  http.get('http://localhost:3001/api/health');
  sleep(1);
}
```

---

## 10. POST-DEPLOYMENT CHECKLIST

```markdown
## Verification
- [ ] Frontend loads without errors
- [ ] Can create/join room via REST
- [ ] Socket.IO connects successfully
- [ ] Can place bids during auction
- [ ] Match simulation runs
- [ ] Results saved to database
- [ ] All-time leaderboard displays

## Monitoring
- [ ] Server logs are being collected
- [ ] CPU/Memory usage is normal
- [ ] Database connection is stable
- [ ] No unhandled promise rejections

## Security
- [ ] HTTPS is enabled
- [ ] CORS only allows your domain
- [ ] Rate limiting is active
- [ ] No sensitive data in logs

## Performance
- [ ] Page load time < 3 seconds
- [ ] Bid response time < 200ms
- [ ] Socket events deliver < 150ms
- [ ] No memory leaks over 24 hours

## Backups
- [ ] Database backups enabled
- [ ] Backup tested and verified
- [ ] Disaster recovery plan documented
```

---

## 11. ROLLBACK PROCEDURE

```bash
# If deployment fails, rollback to previous version

# Heroku
heroku releases
heroku rollback v123

# Vercel
vercel rollback

# Docker
docker-compose down
git revert HEAD~1
docker-compose up -d
```

