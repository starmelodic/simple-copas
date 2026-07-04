import express from "express";
import { promises as fs } from "fs";
import path from "path";
import { nanoid } from "nanoid";

const app = express();
const PORT = 6000;
const PASTES_DIR = "./pastes";

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Middleware untuk static files - HARUS di atas route /:id
app.use(express.static("public"));

async function ensurePastesDir() {
  try {
    await fs.access(PASTES_DIR);
  } catch {
    await fs.mkdir(PASTES_DIR, { recursive: true });
  }
}

function generateShortId() {
  return nanoid(6);
}

function generateContentHash(content) {
  return crypto
    .createHash("sha256")
    .update(content)
    .digest("hex")
    .substring(0, 8);
}

// ROUTE ROOT
app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Simple Copas</title>
    <style>
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; 
            max-width: 800px; 
            margin: 50px auto; 
            padding: 20px; 
            background: #f5f5f5;
        }
        .container {
            background: white;
            padding: 30px;
            border-radius: 10px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        h1 { 
            color: #333;
            margin-top: 0;
        }
        textarea { 
            width: 100%; 
            height: 300px; 
            font-family: 'Courier New', monospace;
            padding: 12px;
            border: 1px solid #ddd;
            border-radius: 5px;
            font-size: 14px;
            resize: vertical;
            box-sizing: border-box;
        }
        textarea:focus {
            outline: none;
            border-color: #007bff;
            box-shadow: 0 0 0 3px rgba(0,123,255,0.1);
        }
        button { 
            background: #007bff; 
            color: white; 
            padding: 12px 30px; 
            border: none; 
            border-radius: 5px;
            cursor: pointer; 
            font-size: 16px;
            font-weight: 600;
            transition: background 0.2s;
        }
        button:hover { 
            background: #0056b3; 
        }
        .info { 
            color: #666; 
            margin-top: 20px; 
            font-size: 0.9em;
            padding: 10px;
            background: #f8f9fa;
            border-radius: 5px;
        }
        .info code {
            background: #e9ecef;
            padding: 2px 6px;
            border-radius: 3px;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>📝 Simple Copas</h1>
        <form action="/paste" method="POST">
            <textarea name="content" placeholder="Tempelkan teks di sini..." required></textarea><br><br>
            <button type="submit">✨ Buat Paste</button>
        </form>
        <div class="info">
            💡 URL akan otomatis dipendekkan (contoh: <code>domain.com/abc123</code>)
        </div>
    </div>
</body>
</html>
  `);
});

app.post("/paste", async (req, res) => {
  try {
    const { content } = req.body;

    if (!content || content.trim() === "") {
      return res.status(400).send(`
<!DOCTYPE html>
<html>
<head><title>Error</title></head>
<body style="font-family: Arial; max-width: 600px; margin: 50px auto; padding: 20px;">
    <h1 style="color: #dc3545;">⚠️ Error</h1>
    <p>Content cannot be empty!</p>
    <p><a href="/" style="color: #007bff;">← Kembali</a></p>
</body>
</html>
      `);
    }

    // Generate ID pendek dengan nanoid
    let id = generateShortId();
    let filename = `${id}.txt`;

    // Pastikan ID unik (mencegah collision)
    let isUnique = false;
    let attempts = 0;
    const maxAttempts = 10;

    while (!isUnique && attempts < maxAttempts) {
      try {
        await fs.access(path.join(PASTES_DIR, filename));
        // File sudah ada, generate ID baru
        id = generateShortId();
        filename = `${id}.txt`;
        attempts++;
      } catch {
        // File tidak ada, ID unik
        isUnique = true;
      }
    }

    if (!isUnique) {
      throw new Error(
        "Failed to generate unique ID after " + maxAttempts + " attempts",
      );
    }

    // Simpan paste
    await fs.writeFile(path.join(PASTES_DIR, filename), content);

    // Simpan hash untuk deduplikasi (opsional)
    // const contentHash = generateContentHash(content);
    // await fs.writeFile(
    //   path.join(PASTES_DIR, `${contentHash}.link`),
    //   id
    // );

    // Gunakan host dari request
    const host = req.headers.host || `localhost:${PORT}`;
    const protocol = req.headers["x-forwarded-proto"] || "http";

    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>✅ Paste Created</title>
    <style>
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif;
            max-width: 800px; 
            margin: 50px auto; 
            padding: 20px; 
            background: #f5f5f5;
        }
        .container {
            background: white;
            padding: 30px;
            border-radius: 10px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        .success { 
            color: #28a745;
            margin-top: 0;
        }
        .url-box { 
            margin: 20px 0; 
            padding: 20px; 
            background: #f8f9fa; 
            border-radius: 8px;
            border: 1px solid #e9ecef;
        }
        .short-url { 
            font-size: 1.8em; 
            font-weight: bold;
            color: #007bff;
            word-break: break-all;
        }
        .domain { 
            color: #666; 
            font-size: 0.8em;
        }
        .btn {
            display: inline-block;
            background: #007bff;
            color: white;
            padding: 10px 20px;
            border-radius: 5px;
            text-decoration: none;
            margin-right: 10px;
            transition: background 0.2s;
        }
        .btn:hover {
            background: #0056b3;
            text-decoration: none;
        }
        .btn-secondary {
            background: #6c757d;
        }
        .btn-secondary:hover {
            background: #5a6268;
        }
        .copy-btn {
            background: #28a745;
            margin-left: 10px;
        }
        .copy-btn:hover {
            background: #218838;
        }
        .copy-message {
            color: #28a745;
            font-size: 0.9em;
            margin-top: 5px;
            display: none;
        }
        .copy-message.show {
            display: block;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1 class="success">✅ Paste Berhasil Dibuat!</h1>
        
        <div class="url-box">
            <div style="margin-bottom: 5px; color: #666;">🔗 URL Paste Anda:</div>
            <div>
                <span class="domain">${protocol}://${host}/</span>
                <a href="/${id}" class="short-url" id="pasteUrl">${id}</a>
                <button onclick="copyUrl()" class="btn copy-btn" style="font-size: 14px;">📋 Copy</button>
            </div>
            <div id="copyMessage" class="copy-message">✅ URL berhasil disalin!</div>
        </div>
        
        <div style="margin-top: 20px;">
            <a href="/${id}" class="btn">🔗 Buka Paste</a>
            <a href="/" class="btn btn-secondary">✏️ Buat Lagi</a>
        </div>
    </div>

    <script>
        function copyUrl() {
            const url = window.location.origin + '/${id}';
            navigator.clipboard.writeText(url).then(() => {
                const msg = document.getElementById('copyMessage');
                msg.classList.add('show');
                setTimeout(() => {
                    msg.classList.remove('show');
                }, 2000);
            });
        }
    </script>
</body>
</html>
    `);
  } catch (error) {
    console.error(error);
    res.status(500).send(`
<!DOCTYPE html>
<html>
<head><title>Error</title></head>
<body style="font-family: Arial; max-width: 600px; margin: 50px auto; padding: 20px;">
    <h1 style="color: #dc3545;">⚠️ Error</h1>
    <p>Terjadi kesalahan: ${error.message}</p>
    <p><a href="/" style="color: #007bff;">← Kembali</a></p>
</body>
</html>
    `);
  }
});

// ROUTE UNTUK VIEW PASTE
app.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    // Filter request yang bukan paste ID
    if (id === "favicon.ico" || id === "robots.txt" || id.includes(".")) {
      return res.status(404).send("Not found");
    }

    // Cek apakah file .txt ada
    const filename = `${id}.txt`;

    try {
      await fs.access(path.join(PASTES_DIR, filename));
    } catch {
      return res.status(404).send(`
<!DOCTYPE html>
<html>
<head><title>❌ Paste Not Found</title></head>
<body style="font-family: Arial; max-width: 600px; margin: 50px auto; padding: 20px;">
    <h1 style="color: #dc3545;">❌ Paste Tidak Ditemukan</h1>
    <p>Paste dengan ID <strong>${id}</strong> tidak ada.</p>
    <p><a href="/" style="color: #007bff;">← Kembali ke Beranda</a></p>
</body>
</html>
      `);
    }

    const content = await fs.readFile(path.join(PASTES_DIR, filename), "utf-8");

    // Escape HTML untuk keamanan
    const escapedContent = content
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    const host = req.headers.host || `localhost:${PORT}`;
    const protocol = req.headers["x-forwarded-proto"] || "http";

    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>📄 Paste ${id}</title>
    <style>
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif;
            max-width: 900px; 
            margin: 50px auto; 
            padding: 20px; 
            background: #f5f5f5;
        }
        .container {
            background: white;
            padding: 30px;
            border-radius: 10px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        .paste-header { 
            display: flex; 
            justify-content: space-between; 
            align-items: center;
            margin-bottom: 20px;
            border-bottom: 1px solid #e9ecef;
            padding-bottom: 15px;
        }
        .paste-header h1 {
            margin: 0;
            color: #333;
        }
        .paste-id { 
            color: #666; 
            font-size: 0.9em;
            background: #f8f9fa;
            padding: 5px 10px;
            border-radius: 4px;
        }
        .paste-content { 
            background: #f8f9fa; 
            border: 1px solid #e9ecef; 
            padding: 20px; 
            white-space: pre-wrap; 
            font-family: 'Courier New', monospace; 
            font-size: 14px;
            overflow-x: auto; 
            border-radius: 5px;
            min-height: 100px;
            line-height: 1.6;
        }
        .tools { 
            margin-top: 20px; 
            padding-top: 15px;
            border-top: 1px solid #e9ecef;
        }
        .tools .btn {
            display: inline-block;
            background: #007bff;
            color: white;
            padding: 8px 16px;
            border-radius: 4px;
            text-decoration: none;
            margin-right: 10px;
            transition: background 0.2s;
        }
        .tools .btn:hover {
            background: #0056b3;
            text-decoration: none;
        }
        .tools .btn-secondary {
            background: #6c757d;
        }
        .tools .btn-secondary:hover {
            background: #5a6268;
        }
        .raw-link { 
            margin-top: 10px;
        }
        .raw-link a {
            color: #007bff;
            text-decoration: none;
        }
        .raw-link a:hover {
            text-decoration: underline;
        }
        .copy-btn {
            background: #28a745;
        }
        .copy-btn:hover {
            background: #218838;
        }
        .copy-message {
            color: #28a745;
            font-size: 0.9em;
            margin-top: 5px;
            display: none;
        }
        .copy-message.show {
            display: block;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="paste-header">
            <h1>📄 Paste</h1>
            <span class="paste-id">ID: ${id}</span>
        </div>
        <div class="paste-content">${escapedContent}</div>
        <div class="tools">
            <a href="/raw/${id}" class="btn">📄 Raw</a>
            <a href="/" class="btn btn-secondary">✏️ Buat Baru</a>
            <button onclick="copyUrl()" class="btn copy-btn">📋 Copy URL</button>
            <div id="copyMessage" class="copy-message">✅ URL berhasil disalin!</div>
        </div>
    </div>

    <script>
        function copyUrl() {
            const url = window.location.href;
            navigator.clipboard.writeText(url).then(() => {
                const msg = document.getElementById('copyMessage');
                msg.classList.add('show');
                setTimeout(() => {
                    msg.classList.remove('show');
                }, 2000);
            });
        }
    </script>
</body>
</html>
    `);
  } catch (error) {
    console.error(error);
    res.status(500).send(`
<!DOCTYPE html>
<html>
<head><title>Error</title></head>
<body style="font-family: Arial; max-width: 600px; margin: 50px auto; padding: 20px;">
    <h1 style="color: #dc3545;">⚠️ Error</h1>
    <p>Terjadi kesalahan: ${error.message}</p>
    <p><a href="/" style="color: #007bff;">← Kembali</a></p>
</body>
</html>
    `);
  }
});

app.get("/raw/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const filename = `${id}.txt`;
    const content = await fs.readFile(path.join(PASTES_DIR, filename), "utf-8");

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.send(content);
  } catch (error) {
    res.status(404).send("Paste not found");
  }
});

async function startServer() {
  await ensurePastesDir();
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`
╔══════════════════════════════════════════════════════════╗
║                                                         ║
║  🚀 Simple Copas Server berjalan!                       ║
║                                                         ║
║  📍 Local:  http://localhost:${PORT}                       ║
║  🌐 Network: http://YOUR_IP:${PORT}                       ║
║                                                         ║
║  📝 Contoh URL: http://localhost:${PORT}/abc123           ║
║                                                         ║
╚══════════════════════════════════════════════════════════╝
    `);
  });
}

startServer().catch(console.error);
