const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS for all origins (Android app & Web clients)
app.use(cors());
app.use(express.json());

// Serve static frontend for customers (Web Portal)
app.use(express.static(path.join(__dirname, 'public')));

// Specific Customer Pages Routes
app.get('/activate', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'activate.html'));
});

app.get('/order', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'order.html'));
});

// Serve static frontend for admin panel
app.use('/admin', express.static(path.join(__dirname, 'public', 'admin')));

// ──────────────── Helper Middleware: Admin Auth ────────────────
function requireAdmin(req, res, next) {
    const authHeader = req.headers['authorization'] || '';
    const pinHeader = req.headers['x-admin-pin'] || '';
    const token = authHeader.replace('Bearer ', '').trim();

    if (token === db.data.admin_config.token || pinHeader === db.data.admin_config.pin) {
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

        const device = db.registerOrGetDevice(deviceId, appId, hardwareInfo);
        const pairing = db.createOrGetPairingCode(deviceId, appId, pairingCode);
        const activeLicense = db.getActiveLicenseForDevice(deviceId);

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
        res.status(500).json({ success: false, error: e.message });
    }
});

/**
 * Request Subscription directly from Android client app
 */
app.post('/api/device/request-subscription', (req, res) => {
    try {
        const { deviceId, pairingCode, requestedPlan, planId, customerName, clientName, customerPhone, clientPhone, notes } = req.body;
        if (!deviceId && !pairingCode) {
            return res.status(400).json({ success: false, message: 'معرف الجهاز أو كود الربط مطلوب' });
        }

        let effectiveCode = pairingCode;
        if (deviceId) {
            db.registerOrGetDevice(deviceId);
            const pairing = db.createOrGetPairingCode(deviceId, 'com.kareemtech.cardSeller', pairingCode);
            effectiveCode = pairing.code;
        }

        const request = db.createSubscriptionRequest({
            pairingCode: effectiveCode,
            requestedPlan: requestedPlan || planId || 'month',
            customerName: customerName || clientName || 'مشترك تطبيق جيب كارت',
            customerPhone: customerPhone || clientPhone || '',
            notes: notes || 'طلب تفعيل مباشر من داخل التطبيق'
        });

        res.json({
            success: true,
            message: 'تم إرسال طلب التفعيل إلى لوحة تحكم المالك بنجاح وهو قيد المراجعة الآن.',
            request
        });
    } catch (e) {
        res.status(400).json({ success: false, message: e.message });
    }
});

/**
 * Record operation:
 * Syncs consumed free operations from Android client to server.
 * Ensures that deleting and reinstalling the app cannot reset the 50 free ops counter!
 */
app.post('/api/device/record-operation', (req, res) => {
    try {
        const { deviceId, count = 1 } = req.body;
        if (!deviceId) {
            return res.status(400).json({ success: false, error: 'MISSING_DEVICE_ID' });
        }

        const activeLicense = db.getActiveLicenseForDevice(deviceId);
        if (activeLicense) {
            return res.json({
                success: true,
                isLicensed: true,
                activeLicense,
                serverTrustedTime: Date.now()
            });
        }

        const result = db.updateDeviceOps(deviceId, count);
        if (!result) {
            return res.status(404).json({ success: false, error: 'DEVICE_NOT_FOUND' });
        }

        res.json({
            success: true,
            isLicensed: false,
            usedFreeOps: result.usedFreeOps,
            freeOpsRemaining: result.freeOpsRemaining,
            isExhausted: result.isExhausted,
            serverTrustedTime: Date.now()
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

/**
 * Check License:
 * Periodic background license verification and refresh.
 */
app.post('/api/device/check-license', (req, res) => {
    try {
        const { deviceId } = req.body;
        if (!deviceId) return res.status(400).json({ success: false, error: 'MISSING_DEVICE_ID' });

        const device = db.getDevice(deviceId);
        const activeLicense = db.getActiveLicenseForDevice(deviceId);

        res.json({
            success: true,
            status: activeLicense ? 'ACTIVE' : (device ? device.status : 'UNKNOWN'),
            activeLicense: activeLicense || null,
            usedFreeOps: device ? device.usedFreeOps : 0,
            freeOpsRemaining: device ? Math.max(0, device.totalFreeOpsLimit - device.usedFreeOps) : 0,
            serverTrustedTime: Date.now()
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ──────────────── 2. Customer Web Portal APIs (موقع الويب) ────────────────

/**
 * Verify Pairing Code entered by customer on website
 */
app.post('/api/web/verify-pairing', (req, res) => {
    try {
        const { code } = req.body;
        if (!code) {
            return res.status(400).json({ success: false, error: 'MISSING_CODE', message: 'يرجى إدخال كود الربط' });
        }

        const result = db.getDeviceByPairingCode(code);
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
app.post('/api/web/submit-request', (req, res) => {
    try {
        const { pairingCode, requestedPlan, customerName, customerPhone, notes } = req.body;
        if (!pairingCode || !requestedPlan) {
            return res.status(400).json({ success: false, message: 'يرجى تحديد كود الربط والباقة المطلوبة.' });
        }

        const request = db.createSubscriptionRequest({
            pairingCode,
            requestedPlan,
            customerName,
            customerPhone,
            notes
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
app.get('/api/web/request-status/:id', (req, res) => {
    try {
        const id = req.params.id.startsWith('#') ? req.params.id : `#${req.params.id}`;
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
app.get('/api/web/request-lookup', (req, res) => {
    try {
        const query = (req.query.q || '').trim();
        if (!query) {
            return res.status(400).json({ success: false, message: 'يرجى إدخال كود الربط أو رقم الطلب' });
        }
        const normalizedId = query.startsWith('#') ? query : `#${query}`;
        let request = db.getRequestById(normalizedId);
        if (!request) {
            const code = query.toUpperCase();
            const allReqs = Object.values(db.data.subscription_requests || {});
            request = allReqs.filter(r => (r.pairingCode || '').toUpperCase() === code).sort((a, b) => b.createdAt - a.createdAt)[0];
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
 * Admin Login
 */
app.post('/api/admin/login', (req, res) => {
    const { pin } = req.body;
    if (pin === db.data.admin_config.pin) {
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
        const id = req.params.id.startsWith('#') ? req.params.id : `#${req.params.id}`;
        const { grantedPlan, grantedDays, adminNotes } = req.body;

        const result = db.approveRequest(id, { grantedPlan, grantedDays, adminNotes });
        res.json({
            success: true,
            message: `تم تفعيل الاشتراك للطلب ${id} بنجاح وإصدار الترخيص.`,
            ...result
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
        const id = req.params.id.startsWith('#') ? req.params.id : `#${req.params.id}`;
        const { reason } = req.body;

        const request = db.rejectRequest(id, reason);
        res.json({
            success: true,
            message: `تم رفض الطلب ${id}.`,
            request
        });
    } catch (e) {
        res.status(400).json({ success: false, message: e.message });
    }
});

/**
 * List all Licenses
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
 * Update License (Extend, Suspend, Revoke, Reactivate)
 */
app.post('/api/admin/licenses/:id/update', requireAdmin, (req, res) => {
    try {
        const licenseId = req.params.id;
        const { action, additionalDays } = req.body;

        const license = db.updateLicense(licenseId, { action, additionalDays });
        res.json({ success: true, license, message: 'تم تحديث الترخيص بنجاح' });
    } catch (e) {
        res.status(400).json({ success: false, message: e.message });
    }
});

/**
 * List all Devices Fleet
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
 * Adjust Device 50 Free Ops Counter
 */
app.post('/api/admin/devices/:id/adjust-ops', requireAdmin, (req, res) => {
    try {
        const deviceId = req.params.id;
        const { usedOps } = req.body;
        const device = db.resetOrAdjustDeviceOps(deviceId, usedOps);
        res.json({ success: true, device, message: 'تم تعديل عداد العمليات بنجاح' });
    } catch (e) {
        res.status(400).json({ success: false, message: e.message });
    }
});

// Start Server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`====================================================`);
    console.log(`🚀 Jeep Card Backend Server is running on port ${PORT}`);
    console.log(`🌐 Customer Web Portal: http://localhost:${PORT}`);
    console.log(`🛡️ Owner Admin Dashboard: http://localhost:${PORT}/admin`);
    console.log(`====================================================`);
});
