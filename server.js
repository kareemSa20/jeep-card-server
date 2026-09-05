const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// ──────────────── Security Hardening ────────────────
// 1. Disable X-Powered-By to prevent server fingerprinting
app.disable('x-powered-by');

// 2. Set strict security HTTP headers
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
});

// 3. Body limit to prevent JSON payload flooding / memory exhaustion
app.use(express.json({ limit: '100kb' }));

// 4. CORS
app.use(cors());

// 5. In-Memory Rate Limiter (Zero-dependency protection against DDoS & Brute Force)
const rateLimitMap = new Map();
function createRateLimiter({ windowMs, maxRequests, message }) {
    return (req, res, next) => {
        const ip = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
        const key = `${req.path}:${ip}`;
        const now = Date.now();
        const record = rateLimitMap.get(key) || { count: 0, resetAt: now + windowMs };

        if (now > record.resetAt) {
            record.count = 1;
            record.resetAt = now + windowMs;
        } else {
            record.count++;
        }
        rateLimitMap.set(key, record);

        if (record.count > maxRequests) {
            return res.status(429).json({
                success: false,
                error: 'TOO_MANY_REQUESTS',
                message: message || 'تم تجاوز الحد الأقصى للمحاولات، يرجى الانتظار والمحاولة لاحقاً.'
            });
        }
        next();
    };
}

// Clean rate limit map every 60s
setInterval(() => {
    const now = Date.now();
    for (const [k, r] of rateLimitMap.entries()) {
        if (now > r.resetAt) rateLimitMap.delete(k);
    }
}, 60000);

const adminLoginLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000, // 15 mins
    maxRequests: 5,           // Max 5 attempts
    message: 'تم حظر محاولات الدخول مؤقتاً بسبب تكرار المحاولات الخاطئة. انتظر 15 دقيقة.'
});

const pairingLimiter = createRateLimiter({
    windowMs: 60 * 1000,      // 1 min
    maxRequests: 30,          // Max 30 attempts
    message: 'عدد كبير من طلبات فحص الكود. يرجى الانتظار دقيقة.'
});

const submitRequestLimiter = createRateLimiter({
    windowMs: 10 * 60 * 1000, // 10 mins
    maxRequests: 10,          // Max 10 submissions
    message: 'تم إرسال عدد كبير من الطلبات. يرجى الانتظار قليلاً.'
});

// Helper: Timing-safe comparison to prevent timing attacks
function safeCompare(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

// Helper: Sanitize text inputs against XSS and excessive length
function sanitizeText(str, maxLen = 255) {
    if (!str) return '';
    return String(str).replace(/[<>]/g, '').trim().substring(0, maxLen);
}

// ──────────────── Serve Customer Static Pages ────────────────
app.use(express.static(path.join(__dirname, 'public')));

// Specific Customer Pages Routes
app.get('/activate', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'activate.html'));
});

app.get('/order', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'order.html'));
});

// Admin Panel Route (Configurable via ADMIN_ROUTE or ADMIN_PATH environment variable, default /admin)
const rawAdminRoute = (process.env.ADMIN_ROUTE || process.env.ADMIN_PATH || '/admin').trim();
const ADMIN_ROUTE = (rawAdminRoute.startsWith('/') ? rawAdminRoute : `/${rawAdminRoute}`).replace(/\/+$/, '');

// Static assets for admin panel under the secret route
app.use(ADMIN_ROUTE, express.static(path.join(__dirname, 'admin_panel')));

// Serve admin index.html for secret route
app.get(ADMIN_ROUTE, (req, res) => {
    res.sendFile(path.join(__dirname, 'admin_panel', 'index.html'));
});

// If custom ADMIN_ROUTE is set, completely block the default /admin route
if (ADMIN_ROUTE !== '/admin') {
    app.all('/admin*', (req, res) => {
        res.status(404).send('Not Found');
    });
}

// Helper: Get active Admin PIN (from Environment Variable or database default)
function getAdminPin() {
    return String(process.env.ADMIN_PIN || (db.data && db.data.admin_config && db.data.admin_config.pin) || '123456').trim();
}

// ──────────────── Helper Middleware: Admin Auth ────────────────
function requireAdmin(req, res, next) {
    const authHeader = req.headers['authorization'] || '';
    const pinHeader = req.headers['x-admin-pin'] || '';
    const token = authHeader.replace('Bearer ', '').trim();
    const currentPin = getAdminPin();
    const currentToken = String((db.data && db.data.admin_config && db.data.admin_config.token) || '').trim();

    if ((token && safeCompare(token, currentToken)) || (pinHeader && safeCompare(pinHeader, currentPin))) {
        return next();
    }
    return res.status(401).json({ success: false, error: 'UNAUTHORIZED', message: 'غير مصرح بالدخول' });
}

// ──────────────── 1. Client App APIs (تطبيق أندرويد العميل) ────────────────

/**
 * Handshake / Register:
 * Called on app launch. Registers device, retrieves existing used ops (anti-reset),
 * issues temporary pairing code, and provides active signed license if already subscribed.
 */
app.post('/api/device/handshake', (req, res) => {
    try {
        const { deviceId, appId, hardwareInfo, pairingCode } = req.body;
        if (!deviceId) {
            return res.status(400).json({ success: false, error: 'MISSING_DEVICE_ID', message: 'معرف الجهاز مطلوب' });
        }

        const cleanDevId = sanitizeText(deviceId, 120);
        const cleanAppId = sanitizeText(appId, 100);
        const cleanPairing = sanitizeText(pairingCode, 20);

        const device = db.registerOrGetDevice(cleanDevId, cleanAppId, hardwareInfo);
        const pairing = db.createOrGetPairingCode(cleanDevId, cleanAppId, cleanPairing);
        const activeLicense = db.getActiveLicenseForDevice(cleanDevId);

        res.json({
            success: true,
            deviceId: device.deviceId,
            appId: device.appId,
            status: device.status,
            usedFreeOps: device.usedFreeOps,
            freeOpsRemaining: Math.max(0, device.totalFreeOpsLimit - device.usedFreeOps),
            totalFreeOpsLimit: device.totalFreeOpsLimit,
            pairingCode: pairing.code,
            pairingCodeExpiresAt: pairing.expiresAt,
            hasActiveLicense: !!activeLicense,
            activeLicense: activeLicense || null,
            serverTrustedTime: Date.now()
        });
    } catch (e) {
        res.status(500).json({ success: false, error: 'INTERNAL_ERROR', message: e.message });
    }
});

/**
 * Verify License status (Online check):
 * Returns valid signed license or notifies client if revoked or expired.
 */
app.post('/api/device/verify-license', (req, res) => {
    try {
        const { deviceId, licenseId } = req.body;
        if (!deviceId) {
            return res.status(400).json({ success: false, error: 'MISSING_DEVICE_ID' });
        }

        const cleanDevId = sanitizeText(deviceId, 120);
        const activeLicense = db.getActiveLicenseForDevice(cleanDevId);

        if (!activeLicense) {
            const dev = db.getDevice(cleanDevId);
            return res.json({
                success: true,
                hasActiveLicense: false,
                status: dev ? dev.status : 'TRIAL',
                usedFreeOps: dev ? dev.usedFreeOps : 0,
                freeOpsRemaining: dev ? Math.max(0, dev.totalFreeOpsLimit - dev.usedFreeOps) : 50,
                message: 'لا يوجد ترخيص مدفوع نشط لجهازك.'
            });
        }

        res.json({
            success: true,
            hasActiveLicense: true,
            license: activeLicense,
            serverTrustedTime: Date.now()
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

/**
 * Report Consumed Free Operation:
 * Anti-Tamper & Anti-Reset mechanism.
 * The app reports every operation consumed so user cannot reinstall to regain 50 free ops.
 */
app.post('/api/device/consume-ops', (req, res) => {
    try {
        const { deviceId, count } = req.body;
        if (!deviceId) {
            return res.status(400).json({ success: false, error: 'MISSING_DEVICE_ID' });
        }

        const cleanDevId = sanitizeText(deviceId, 120);
        const increment = Math.max(1, parseInt(count, 10) || 1);
        const device = db.consumeDeviceFreeOp(cleanDevId, increment);

        res.json({
            success: true,
            usedFreeOps: device.usedFreeOps,
            freeOpsRemaining: Math.max(0, device.totalFreeOpsLimit - device.usedFreeOps),
            isExhausted: device.usedFreeOps >= device.totalFreeOpsLimit
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

/**
 * Sync Active License manually (زر مزامنة الترخيص في التطبيق):
 */
app.post('/api/device/sync-license', (req, res) => {
    try {
        const { deviceId } = req.body;
        if (!deviceId) {
            return res.status(400).json({ success: false, error: 'MISSING_DEVICE_ID' });
        }

        const cleanDevId = sanitizeText(deviceId, 120);
        const activeLicense = db.getActiveLicenseForDevice(cleanDevId);
        const device = db.getDevice(cleanDevId);

        if (!device) {
            return res.status(404).json({ success: false, error: 'DEVICE_NOT_FOUND', message: 'الجهاز غير مسجل' });
        }

        res.json({
            success: true,
            hasActiveLicense: !!activeLicense,
            license: activeLicense || null,
            deviceStatus: device.status,
            usedFreeOps: device.usedFreeOps,
            serverTrustedTime: Date.now()
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

/**
 * Submit Subscription Request directly from Client Android App (إرسال طلب التفعيل إلى المالك من داخل التطبيق)
 */
app.post('/api/device/request-subscription', submitRequestLimiter, (req, res) => {
    try {
        const { deviceId, appId, hardwareModel, hardwareFingerprint, pairingCode, requestedPlan, customerName, customerPhone, notes } = req.body;
        if (!deviceId && !pairingCode) {
            return res.status(400).json({ success: false, message: 'معرف الجهاز أو كود الربط مطلوب' });
        }

        let code = pairingCode;
        if (deviceId) {
            const cleanDevId = sanitizeText(deviceId, 120);
            const cleanAppId = sanitizeText(appId || 'com.kareemtech.cardSeller', 100);
            const hwInfo = { model: sanitizeText(hardwareModel || '', 80), fingerprint: sanitizeText(hardwareFingerprint || '', 120) };
            db.registerOrGetDevice(cleanDevId, cleanAppId, hwInfo);
            if (!code) {
                const pairing = db.createOrGetPairingCode(cleanDevId, cleanAppId);
                code = pairing.code;
            }
        }

        const cleanCode = sanitizeText(code, 30).toUpperCase();
        const cleanPlan = sanitizeText(requestedPlan || 'month', 30);
        const cleanName = sanitizeText(customerName || 'مشترك التطبيق', 100);
        const cleanPhone = sanitizeText(customerPhone || '', 30);
        const cleanNotes = sanitizeText(notes || '', 500);

        const request = db.createSubscriptionRequest({
            pairingCode: cleanCode,
            requestedPlan: cleanPlan,
            customerName: cleanName,
            customerPhone: cleanPhone,
            notes: cleanNotes
        });

        res.json({
            success: true,
            message: 'تم استلام طلب التفعيل بنجاح وإرساله إلى إدارة طلبات الاشتراكات في لوحة المالك.',
            request,
            requestId: request.id
        });
    } catch (e) {
        res.status(400).json({ success: false, message: e.message });
    }
});

// ──────────────── 2. Web Portal APIs (موقع الويب للعملاء) ────────────────

/**
 * Verify Pairing Code entered by customer on web page
 */
app.post('/api/web/verify-pairing', pairingLimiter, (req, res) => {
    try {
        const { code } = req.body;
        if (!code || typeof code !== 'string') {
            return res.status(400).json({ success: false, message: 'كود الربط مطلوب' });
        }

        const cleanCode = sanitizeText(code, 30);
        const result = db.getDeviceByPairingCode(cleanCode);

        if (!result) {
            return res.status(404).json({ success: false, error: 'INVALID_CODE', message: 'كود الربط غير صحيح، تحقق من الكود في التطبيق.' });
        }
        if (result.error) {
            return res.status(400).json({ success: false, error: result.error, message: result.message });
        }

        res.json({
            success: true,
            pairing: result.pairing,
            device: result.device
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

/**
 * Submit Subscription Request from website
 */
app.post('/api/web/submit-request', submitRequestLimiter, (req, res) => {
    try {
        const { pairingCode, requestedPlan, customerName, customerPhone, notes } = req.body;
        if (!pairingCode || !requestedPlan) {
            return res.status(400).json({ success: false, message: 'يرجى تحديد كود الربط والباقة المطلوبة.' });
        }

        const cleanCode = sanitizeText(pairingCode, 25).toUpperCase();
        const cleanPlan = sanitizeText(requestedPlan, 30);
        const cleanName = sanitizeText(customerName, 100);
        const cleanPhone = sanitizeText(customerPhone, 30);
        const cleanNotes = sanitizeText(notes, 500);

        const request = db.createSubscriptionRequest({
            pairingCode: cleanCode,
            requestedPlan: cleanPlan,
            customerName: cleanName,
            customerPhone: cleanPhone,
            notes: cleanNotes
        });

        res.json({
            success: true,
            message: 'تم إرسال طلب الاشتراك بنجاح وهو قيد المراجعة الآن.',
            request
        });
    } catch (e) {
        res.status(400).json({ success: false, message: e.message });
    }
});

/**
 * Get status of an existing request
 */
app.get('/api/web/request-status/:id', pairingLimiter, (req, res) => {
    try {
        const rawId = sanitizeText(req.params.id, 20);
        const id = rawId.startsWith('#') ? rawId : `#${rawId}`;
        const request = db.getRequestById(id);
        if (!request) {
            return res.status(404).json({ success: false, message: 'الطلب غير موجود' });
        }
        res.json({ success: true, request });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

/**
 * Lookup request by ID or Pairing Code
 */
app.get('/api/web/request-lookup', pairingLimiter, (req, res) => {
    try {
        const query = sanitizeText(req.query.q || '', 40);
        if (!query) {
            return res.status(400).json({ success: false, message: 'يرجى إدخال كود الربط أو رقم الطلب' });
        }
        const normalizedId = query.startsWith('#') ? query : `#${query}`;
        let request = db.getRequestById(normalizedId);
        if (!request) {
            const cleanCode = query.replace(/[^A-Z0-9]/g, '').toUpperCase();
            const allReqs = Object.values(db.data.subscription_requests || {});
            request = allReqs.filter(r => {
                const reqCode = (r.pairingCode || '').replace(/[^A-Z0-9]/g, '').toUpperCase();
                return reqCode === cleanCode;
            }).sort((a, b) => b.createdAt - a.createdAt)[0];
        }
        if (!request) {
            return res.status(404).json({ success: false, message: 'لم يتم العثور على أي طلب مطابق.' });
        }
        res.json({ success: true, request });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ──────────────── 3. Owner / Admin Control Panel APIs ────────────────

/**
 * Admin Login (Rate limited & Timing-safe)
 */
app.post('/api/admin/login', adminLoginLimiter, (req, res) => {
    const { pin } = req.body;
    const currentPin = getAdminPin();

    if (pin && safeCompare(String(pin).trim(), currentPin)) {
        return res.json({
            success: true,
            token: db.data.admin_config.token,
            message: 'تم تسجيل الدخول بنجاح'
        });
    }
    return res.status(401).json({ success: false, message: 'رمز الدخول (PIN) غير صحيح' });
});

/**
 * Dashboard Overview Stats
 */
app.get('/api/admin/dashboard', requireAdmin, (req, res) => {
    try {
        const stats = db.getDashboardStats();
        res.json({ success: true, stats });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

/**
 * List Subscription Requests
 */
app.get('/api/admin/requests', requireAdmin, (req, res) => {
    try {
        const { status } = req.query;
        const requests = db.getRequests(status);
        res.json({ success: true, requests });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

/**
 * Approve Request (with custom plan & custom days)
 */
app.post('/api/admin/requests/:id/approve', requireAdmin, (req, res) => {
    try {
        const { grantedPlan, grantedDays, adminNotes } = req.body;
        const result = db.approveRequest(req.params.id, { grantedPlan, grantedDays, adminNotes });

        res.json({
            success: true,
            message: `تم اعتماد الطلب وتفعيل ترخيص الجهاز بنجاح (${result.request.grantedDays} يوم).`,
            request: result.request,
            license: result.license
        });
    } catch (e) {
        res.status(400).json({ success: false, message: e.message });
    }
});

/**
 * Reject Request
 */
app.post('/api/admin/requests/:id/reject', requireAdmin, (req, res) => {
    try {
        const { reason } = req.body;
        const request = db.rejectRequest(req.params.id, reason);
        res.json({
            success: true,
            message: 'تم رفض طلب الاشتراك.',
            request
        });
    } catch (e) {
        res.status(400).json({ success: false, message: e.message });
    }
});

/**
 * List Devices
 */
app.get('/api/admin/devices', requireAdmin, (req, res) => {
    try {
        const devices = db.getAllDevices();
        res.json({ success: true, devices });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

/**
 * Adjust device used free operations limit manually
 */
app.post('/api/admin/devices/:id/adjust-ops', requireAdmin, (req, res) => {
    try {
        const { usedOps } = req.body;
        const device = db.adjustDeviceOps(req.params.id, usedOps);
        res.json({
            success: true,
            message: `تم ضبط رصيد العمليات المجانية للجهاز بنجاح (${device.usedFreeOps} مستخدمة).`,
            device
        });
    } catch (e) {
        res.status(400).json({ success: false, message: e.message });
    }
});

/**
 * List Licenses
 */
app.get('/api/admin/licenses', requireAdmin, (req, res) => {
    try {
        const licenses = db.getAllLicenses();
        res.json({ success: true, licenses });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

/**
 * Revoke License
 */
app.post('/api/admin/licenses/:id/revoke', requireAdmin, (req, res) => {
    try {
        const license = db.revokeLicense(req.params.id);
        res.json({
            success: true,
            message: 'تم إلغاء تفعيل الترخيص بنجاح.',
            license
        });
    } catch (e) {
        res.status(400).json({ success: false, message: e.message });
    }
});

// ──────────────── Start Server ────────────────
app.listen(PORT, () => {
    console.log('====================================================');
    console.log(`🚀 Jeep Card Backend Server is running on port ${PORT}`);
    console.log(`🌐 Customer Web Portal: http://localhost:${PORT}`);
    console.log(`🛡️ Owner Admin Dashboard: http://localhost:${PORT}${ADMIN_ROUTE}`);
    if (ADMIN_ROUTE !== '/admin') {
        console.log(`🔒 Custom Secret Admin Path active: ${ADMIN_ROUTE} (default /admin disabled)`);
    }
    if (process.env.ADMIN_PIN) {
        console.log(`🔒 Custom Admin PIN active from Environment Variable`);
    }
    console.log('🔒 Security headers, rate limiting & sanitization ACTIVE');
    console.log('====================================================');
});
