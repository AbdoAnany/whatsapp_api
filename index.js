require('dotenv').config();
const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3001;

// Middleware
app.use(express.json());
app.use(cors());

// Rate limiting
const otpLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 15, // Limit each IP to 15 OTP requests per windowMs
    message: 'Too many OTP requests, please try again later.',
});
app.use('/send-otp', otpLimiter);

// MongoDB connection
mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
})
    .then(() => console.log('Connected to MongoDB'))
    .catch(err => console.error('MongoDB connection error:', err));

// OTP schema
const otpSchema = new mongoose.Schema({
    phoneNumber: { type: String, required: true },
    otp: { type: String, required: true },
    createdAt: { type: Date, default: Date.now, expires: 300 }, // OTP expires after 5 minutes
});
const OTP = mongoose.model('OTP', otpSchema);

// WhatsApp client setup
const client = new Client({
    puppeteer: {
        headless: true, // Run in headless mode
        args: ['--no-sandbox', '--disable-setuid-sandbox'], // Required for Render
    },
    authStrategy: new LocalAuth({ clientId: "client-one" }),
});

// Track WhatsApp client readiness
let isClientReady = false;

// Event: Generate QR code for authentication
client.on('qr', (qr) => {
    console.log('QR RECEIVED:', qr);
    QRCode.toDataURL(qr, (err, url) => {
        if (err) {
            console.error('Error generating QR code:', err);
        } else {
            console.log('QR Code URL:', url);
        }
    });
});

// Event: Client is ready
client.on('ready', () => {
    console.log('Client is ready!');
    isClientReady = true;
});

// Event: Handle authentication failure
client.on('auth_failure', (msg) => {
    console.error('Authentication failed:', msg);
    isClientReady = false;
});

// Event: Handle client disconnection
client.on('disconnected', (reason) => {
    console.log('Client disconnected:', reason);
    isClientReady = false;
});

// Initialize the WhatsApp client
client.initialize();

// Endpoint to generate and send OTP
app.post('/send-otp', async (req, res) => {
    if (!isClientReady) {
        return res.status(500).json({ error: 'WhatsApp client is not ready' });
    }

    const { phoneNumber } = req.body;

    if (!phoneNumber) {
        return res.status(400).json({ error: 'Phone number is required' });
    }

    // Generate a 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    // Save the OTP to MongoDB
    const otpRecord = new OTP({ phoneNumber, otp });
    await otpRecord.save();

    // Format the phone number for WhatsApp
    const formattedNumber = `2${phoneNumber}@c.us`; // Assuming country code is 20 (Egypt)
    console.log('Formatted Number:', formattedNumber);

    // Send the OTP via WhatsApp
    try {
        await client.sendMessage(formattedNumber, `Your OTP is: ${otp}`);
        res.json({ success: true, message: 'OTP sent successfully' });
    } catch (error) {
        console.error('Error sending OTP:', error);
        if (error.message.includes('not registered')) {
            res.status(400).json({ error: 'Recipient is not registered on WhatsApp' });
        } else {
            res.status(500).json({ error: 'Failed to send OTP' });
        }
    }
});

// Endpoint to validate OTP
app.post('/validate-otp', async (req, res) => {
    const { phoneNumber, otp } = req.body;

    if (!phoneNumber || !otp) {
        return res.status(400).json({ error: 'Phone number and OTP are required' });
    }

    // Find the OTP record in MongoDB
    const otpRecord = await OTP.findOne({ phoneNumber, otp });

    if (!otpRecord) {
        return res.status(400).json({ error: 'Invalid OTP or OTP expired' });
    }

    // Delete the OTP record after successful validation
    await OTP.deleteOne({ _id: otpRecord._id });

    res.json({ success: true, message: 'OTP is valid' });
});

// Start the Express server
app.listen(port, () => {
    console.log(`Server is running at http://localhost:${port}`);
});