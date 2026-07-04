# 📝 Simple Copas

Simple pastebin-like application with short URLs using Nanoid. Share text quickly with short, memorable URLs.

## ✨ Features

- 🔗 Short URLs - Uses Nanoid to generate 6-character URLs
- 📋 Copy to Clipboard - One-click copy URL
- 🗄️ File-based Storage - Stores pastes as text files
- 🎨 Clean UI - Modern, responsive design
- 🚀 Fast & Lightweight - Minimal dependencies
- 🔒 Secure - HTML escaping to prevent XSS

## 📦 Installation

### Prerequisites
- Node.js >= 20.0.0
- npm or yarn

### Steps

1. Clone the repository
git clone https://github.com/starmelodic/simple-copas.git
cd simple-copas

2. Install dependencies
npm install

3. Start the server
npm start

4. Open your browser and visit http://localhost:6000

## 🚀 Deployment

### Using PM2 (Recommended for Production)

Install PM2 globally:
npm install -g pm2

Start the application:
pm2 start index.js --name simple-copas

View logs:
pm2 logs simple-copas

Restart application:
pm2 restart simple-copas

Stop application:
pm2 stop simple-copas

### Using Nginx as Reverse Proxy

Create Nginx configuration:
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:6000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}

### Using Docker

Create Dockerfile:
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 6000
CMD ["node", "index.js"]

Build and run:
docker build -t simple-copas .
docker run -p 6000:6000 -v $(pwd)/pastes:/app/pastes simple-copas

## 📁 Project Structure

simple-copas/
├── index.js          # Main application file
├── package.json      # Dependencies and scripts
├── README.md         # Documentation
├── .gitignore        # Git ignore file
└── pastes/           # Saved paste files (auto-created)
    ├── abc123.txt    # Paste content
    └── xyz789.txt    # Paste content

## 🔧 Configuration

### Changing Port
Edit the PORT variable in index.js:
const PORT = 6000; // Change to your preferred port

### Changing URL Length
Modify the Nanoid length in generateShortId() function:
function generateShortId() {
  return nanoid(6); // Change 6 to desired length
}

## 🛠️ API Endpoints

Method | Endpoint | Description
GET    | /        | Home page
POST   | /paste   | Create new paste
GET    | /:id     | View paste
GET    | /raw/:id | View raw paste

### API Usage Example

Create a paste:
curl -X POST http://localhost:6000/paste -d "content=Hello World" -H "Content-Type: application/x-www-form-urlencoded"

Get paste content:
curl http://localhost:6000/abc123

Get raw content:
curl http://localhost:6000/raw/abc123

## 🧪 Testing

Test with curl:
curl -X POST http://localhost:6000/paste -d "content=Test paste"

Test with httpie:
http POST http://localhost:6000/paste content="Test paste"

## 🐛 Troubleshooting

### Port already in use
Find process using port:
lsof -i :6000

Kill process:
kill -9 [PID]

### Permission denied
Make sure pastes directory has write permissions:
chmod 755 pastes

### Module not found
Clear npm cache and reinstall:
npm cache clean --force
rm -rf node_modules package-lock.json
npm install

## 📝 License

MIT License - see LICENSE file for details

## 👤 Author

Your Name
GitHub: @starmelodic

## ⭐ Support

Give a star if this project helped you!

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the project
2. Create your feature branch (git checkout -b feature/AmazingFeature)
3. Commit your changes (git commit -m 'Add some AmazingFeature')
4. Push to the branch (git push origin feature/AmazingFeature)
5. Open a Pull Request