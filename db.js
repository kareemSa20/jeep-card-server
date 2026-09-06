const fs = require('fs');
const path = require('path');
const { signLicense, generatePairingCode } = require('./cryptoSigner');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'database.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DEFAULT_DB = {
    devices: {},
    pairing_codes: {},
    subscription_requests: [],
    licenses: {},
    audit_logs: [],
    request_seq: 1840,
    admin_config: {
        pin: "123456",
        token: "admin_secret_token_jeep_card_2026"
    }
};

class Database {
    constructor() {
        this.data = this.load();
    }

    load() {
        try {
            if (fs.existsSync(DB_FILE)) {
                const content = fs.readFileSync(DB_FILE, 'utf8');
                const loaded = Object.assign({}, DEFAULT_DB, JSON.parse(content));
                // Clean up any historical duplicate requests:
                if (Array.isArray(loaded.subscription_requests)) {
                    const seen = new Set();
                    const cleanReqs = [];
                    for (const req of loaded.subscription_requests) {
                        const norm = (req.pairingCode || '').replace(/[^A-Z0-9]/g, '').toUpperCase() || req.deviceId;
                        if (!seen.has(norm)) {
                            seen.add(norm);
                            cleanReqs.push(req);
                        }
                    }
                    loaded.subscription_requests = cleanReqs;
                }
                return loaded;
            }
        } catch (e) {
            console.error('Error loading database, resetting to default:', e);
        }
        return JSON.parse(JSON.stringify(DEFAULT_DB));
    }

    save() {
        try {
            const tempFile = DB_FILE + '.tmp';
            fs.writeFileSync(tempFile, JSON.stringify(this.data, null, 2), 'utf8');
            fs.renameSync(tempFile, DB_FILE);
        } catch (e) {
            console.error('Error saving database:', e);
        }
    }

    // ──────────────── Devices & 50 Free Ops (Anti-Reinstall) ────────────────

    registerOrGetDevice(deviceId, appId, hardwareInfo = {}) {
        const now = Date.now();
        let device = this.data.devices[deviceId];

        if (!device) {
            // New Device registration
            device = {
                deviceId,
                appId: appId || 'com.kareemtech.cardSeller',
                hardwareModel: hardwareInfo.model || 'Android Device',
                hardwareFingerprint: hardwareInfo.fingerprint || '',
                totalFreeOpsLimit: 50,
                usedFreeOps: 0,
                status: 'TRIAL', // TRIAL, ACTIVE, EXPIRED, BLOCKED
                activeLicenseId: null,
                firstSeenAt: now,
                lastSeenAt: now
            };
            this.data.devices[deviceId] = device;
            this.logAudit('DEVICE_REGISTERED', `Device ${deviceId} registered with 50 free ops`, deviceId);
        } else {
            // Existing Device - preserve usedFreeOps to prevent counter resets!
            device.lastSeenAt = now;
            if (hardwareInfo.model) device.hardwareModel = hardwareInfo.model;
            if (hardwareInfo.fingerprint) device.hardwareFingerprint = hardwareInfo.fingerprint;
            if (appId) device.appId = appId;
        }

        // Check if device has an active license that has expired
        const activeLicense = this.getActiveLicenseForDevice(deviceId);
        if (activeLicense) {
            if (activeLicense.expiresAt > 0 && now > activeLicense.expiresAt) {
                device.status = 'EXPIRED';
            } else if (device.status !== 'BLOCKED') {
                device.status = 'ACTIVE';
            }
        } else if (device.usedFreeOps >= device.totalFreeOpsLimit) {
            device.status = 'EXHAUSTED';
        }

        this.save();
        return device;
    }

    getDevice(deviceId) {
        return this.data.devices[deviceId] || null;
    }

    getAllDevices() {
        const now = Date.now();
        return Object.values(this.data.devices).map(dev => {
            const license = this.getActiveLicenseForDevice(dev.deviceId);
            // Find latest pairing code for this device
            const pairings = Object.values(this.data.pairing_codes || {})
                .filter(p => p.deviceId === dev.deviceId)
                .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
            const latestPairing = pairings.length > 0 ? pairings[0].code : (license ? (license.pairingCode || '-') : '-');

            return {
                ...dev,
                pairingCode: latestPairing,
                freeOpsRemaining: Math.max(0, dev.totalFreeOpsLimit - dev.usedFreeOps),
                license: license || null
            };
        });
    }

    updateDeviceOps(deviceId, count) {
        const device = this.getDevice(deviceId);
        if (!device) return null;

        // Increment consumed free operations up to totalFreeOpsLimit
        const added = Number(count) || 1;
        device.usedFreeOps = Math.min(device.totalFreeOpsLimit, device.usedFreeOps + added);
        device.lastSeenAt = Date.now();

        if (device.usedFreeOps >= device.totalFreeOpsLimit && !this.getActiveLicenseForDevice(deviceId)) {
            device.status = 'EXHAUSTED';
        }

        this.logAudit('OPS_INCREMENTED', `Device ${deviceId} consumed ${added} ops. Total used: ${device.usedFreeOps}/50`, deviceId);
        this.save();

        return {
            usedFreeOps: device.usedFreeOps,
            freeOpsRemaining: Math.max(0, device.totalFreeOpsLimit - device.usedFreeOps),
            isExhausted: device.usedFreeOps >= device.totalFreeOpsLimit
        };
    }

    resetOrAdjustDeviceOps(deviceId, newUsedOps) {
        const device = this.getDevice(deviceId);
        if (!device) return null;

        device.usedFreeOps = Math.max(0, Math.min(device.totalFreeOpsLimit, Number(newUsedOps) || 0));
        if (device.usedFreeOps < device.totalFreeOpsLimit && device.status === 'EXHAUSTED') {
            device.status = 'TRIAL';
        }
        this.logAudit('OPS_ADJUSTED', `Admin adjusted device ${deviceId} used ops to ${device.usedFreeOps}`, deviceId);
        this.save();
        return device;
    }

    // ──────────────── Pairing Codes ────────────────

    createOrGetPairingCode(deviceId, appId, clientCode) {
        const now = Date.now();
        const EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours validity

        if (clientCode && clientCode.trim().length >= 4 && clientCode !== '----') {
            const normalizedClient = clientCode.trim().toUpperCase();
            this.data.pairing_codes[normalizedClient] = {
                code: normalizedClient,
                deviceId,
                appId: appId || 'com.kareemtech.cardSeller',
                createdAt: now,
                expiresAt: now + EXPIRY_MS,
                status: 'UNUSED'
            };
            this.save();
            return { code: normalizedClient, expiresAt: now + EXPIRY_MS };
        }

        // Look for existing active code for this device
        for (const [code, info] of Object.entries(this.data.pairing_codes)) {
            if (info.deviceId === deviceId && info.expiresAt > now && info.status === 'UNUSED') {
                return { code, expiresAt: info.expiresAt };
            }
        }

        // Generate a new code
        let newCode = generatePairingCode();
        while (this.data.pairing_codes[newCode] && this.data.pairing_codes[newCode].expiresAt > now) {
            newCode = generatePairingCode();
        }

        const expiresAt = now + EXPIRY_MS;
        this.data.pairing_codes[newCode] = {
            code: newCode,
            deviceId,
            appId: appId || 'com.kareemtech.cardSeller',
            createdAt: now,
            expiresAt,
            status: 'UNUSED'
        };

        this.save();
        return { code: newCode, expiresAt };
    }

    getDeviceByPairingCode(code) {
        if (!code) return null;
        const normalized = code.trim().toUpperCase();
        let pairing = this.data.pairing_codes[normalized];

        // If not found by exact string, search by stripped alphanumeric
        if (!pairing) {
            const cleanCode = normalized.replace(/[^A-Z0-9]/g, '');
            for (const [key, p] of Object.entries(this.data.pairing_codes)) {
                const cleanKey = key.replace(/[^A-Z0-9]/g, '');
                if (cleanKey === cleanCode) {
                    pairing = p;
                    break;
                }
            }
        }

        if (!pairing) return null;

        const now = Date.now();
        if (pairing.expiresAt < now) {
            pairing.status = 'EXPIRED';
            this.save();
            return { error: 'EXPIRED_CODE', message: 'كود الربط منتهي الصلاحية، يرجى إعادة فتح التطبيق للحصول على كود جديد.' };
        }

        const device = this.getDevice(pairing.deviceId);
        if (!device) return null;

        const license = this.getActiveLicenseForDevice(device.deviceId);
        return {
            pairing,
            device: {
                deviceId: device.deviceId,
                appId: device.appId,
                hardwareModel: device.hardwareModel,
                status: device.status,
                usedFreeOps: device.usedFreeOps,
                freeOpsRemaining: Math.max(0, device.totalFreeOpsLimit - device.usedFreeOps),
                totalFreeOpsLimit: device.totalFreeOpsLimit,
                hasActiveLicense: !!license,
                activeLicense: license || null
            }
        };
    }

    // ──────────────── Subscription Requests ────────────────

    createSubscriptionRequest({ pairingCode, requestedPlan, customerName, customerPhone, notes }) {
        const verify = this.getDeviceByPairingCode(pairingCode);
        if (!verify || verify.error) {
            throw new Error(verify ? verify.message : 'كود الربط غير صحيح أو منتهي.');
        }

        const { device } = verify;
        const now = Date.now();
        const cleanCode = (pairingCode || '').trim().toUpperCase();
        const normIncoming = cleanCode.replace(/[^A-Z0-9]/g, '');

        // 1. If device already has an active approved license, reject new request immediately
        const actualDev = this.getDevice(device.deviceId);
        const activeLic = this.getActiveLicenseForDevice(device.deviceId) ||
            Object.values(this.data.licenses || {}).find(l => 
                (l.deviceId === device.deviceId || (l.pairingCode && l.pairingCode.replace(/[^A-Z0-9]/g, '') === normIncoming)) &&
                l.status === 'ACTIVE' &&
                (l.expiresAt === 0 || l.expiresAt > now)
            );

        if (activeLic && activeLic.status === 'ACTIVE') {
            const isLifetime = activeLic.expiresAt === 0;
            const remainingMs = isLifetime ? Infinity : (activeLic.expiresAt - now);
            const remainingDays = isLifetime ? 9999 : Math.ceil(remainingMs / (24 * 60 * 60 * 1000));
            if (isLifetime || remainingDays > 7) {
                throw new Error(`طلبك السابق تم قبوله بالفعل وترخيصك نشط (${activeLic.planName || activeLic.plan})، متبقي ${remainingDays} يوم. أنت مشترك بالفعل!`);
            }
        }

        // Map plans to prices and default days
        const PLAN_MAP = {
            'month': { name: 'اشتراك شهر', price: '2500 ريال يمني', days: 30 },
            '6months': { name: 'اشتراك 6 أشهر', price: '5000 ريال يمني', days: 180 },
            'year': { name: 'اشتراك سنة', price: '10000 ريال يمني', days: 365 },
            'lifetime': { name: 'اشتراك دائم', price: '50000 ريال يمني', days: 36500 }
        };

        const planConfig = PLAN_MAP[requestedPlan] || { name: requestedPlan, price: 'حسب الاتفاق', days: 30 };

        // 2. Check if a request already exists for this device or pairing code (PREVENT DUPLICATES)
        const existingReq = this.data.subscription_requests.find(r => {
            const normReq = (r.pairingCode || '').replace(/[^A-Z0-9]/g, '');
            return (r.deviceId === device.deviceId || (normIncoming && normReq === normIncoming));
        });

        if (existingReq) {
            // If already approved with an active license, reject
            if (existingReq.status === 'APPROVED' && existingReq.issuedLicenseId) {
                const lic = this.data.licenses[existingReq.issuedLicenseId];
                if (lic && lic.status === 'ACTIVE' && (lic.expiresAt === 0 || lic.expiresAt > now)) {
                    const isLifetime = lic.expiresAt === 0;
                    const remainingMs = isLifetime ? Infinity : (lic.expiresAt - now);
                    const remainingDays = isLifetime ? 9999 : Math.ceil(remainingMs / (24 * 60 * 60 * 1000));
                    if (isLifetime || remainingDays > 7) {
                        throw new Error(`طلبك السابق تم قبوله بالفعل وترخيصك نشط (${lic.planName || lic.plan})، متبقي ${remainingDays} يوم. أنت مشترك بالفعل!`);
                    }
                }
            }

            // Update existing request in-place with latest data (DO NOT CREATE DUPLICATE)
            existingReq.pairingCode = cleanCode;
            existingReq.customerName = customerName || existingReq.customerName;
            existingReq.customerPhone = customerPhone || existingReq.customerPhone;
            existingReq.requestedPlan = requestedPlan;
            existingReq.requestedPlanName = planConfig.name;
            existingReq.requestedPrice = planConfig.price;
            existingReq.requestedDays = planConfig.days;
            existingReq.notes = notes || existingReq.notes;
            existingReq.status = 'PENDING'; // Re-open as pending with updated data
            existingReq.rejectionReason = '';
            existingReq.updatedAt = now;

            // Move to top so admin sees recent activity
            const index = this.data.subscription_requests.indexOf(existingReq);
            if (index > 0) {
                this.data.subscription_requests.splice(index, 1);
                this.data.subscription_requests.unshift(existingReq);
            }

            if (this.data.pairing_codes[cleanCode]) {
                this.data.pairing_codes[cleanCode].status = 'PAIRED';
            }

            this.logAudit('REQUEST_UPDATED', `Request ${existingReq.id} updated with latest details for device ${device.deviceId}`, device.deviceId);
            this.save();
            return existingReq;
        }

        // 3. If no existing request, create new request
        this.data.request_seq = (this.data.request_seq || 1840) + 1;
        const requestId = `#${this.data.request_seq}`;

        const request = {
            id: requestId,
            deviceId: device.deviceId,
            appId: device.appId,
            hardwareModel: device.hardwareModel,
            pairingCode: cleanCode,
            customerName: customerName || 'مشترك',
            customerPhone: customerPhone || '',
            requestedPlan: requestedPlan,
            requestedPlanName: planConfig.name,
            requestedPrice: planConfig.price,
            requestedDays: planConfig.days,
            notes: notes || '',
            status: 'PENDING', // PENDING, APPROVED, REJECTED, CANCELLED
            rejectionReason: '',
            grantedPlan: null,
            grantedDays: null,
            issuedLicenseId: null,
            createdAt: now,
            reviewedAt: null
        };

        this.data.subscription_requests.unshift(request);

        // Mark pairing code as PAIRED
        if (this.data.pairing_codes[request.pairingCode]) {
            this.data.pairing_codes[request.pairingCode].status = 'PAIRED';
        }

        this.logAudit('REQUEST_CREATED', `Request ${requestId} created for device ${device.deviceId}`, device.deviceId);
        this.save();
        return request;
    }

    getRequests(statusFilter = null) {
        if (!statusFilter || statusFilter === 'ALL') {
            return this.data.subscription_requests;
        }
        return this.data.subscription_requests.filter(r => r.status === statusFilter);
    }

    getRequestById(requestId) {
        return this.data.subscription_requests.find(r => r.id === requestId) || null;
    }

    // ──────────────── Approvals & License Issuance ────────────────

    approveRequest(requestId, { grantedPlan, grantedDays, adminNotes }) {
        const req = this.getRequestById(requestId);
        if (!req) throw new Error('الطلب غير موجود');
        if (req.status === 'APPROVED') throw new Error('تمت الموافقة على هذا الطلب مسبقاً');

        const now = Date.now();
        const days = Number(grantedDays) || req.requestedDays || 30;
        const plan = grantedPlan || req.requestedPlan || 'month';

        // Issue cryptographically signed license
        const licenseId = `LIC-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
        const isLifetime = plan === 'lifetime' || days >= 36500;
        const expiresAt = isLifetime ? 0 : now + (days * 24 * 60 * 60 * 1000);

        const rawLicense = {
            id: licenseId,
            deviceId: req.deviceId,
            pairingCode: req.pairingCode || '',
            appId: req.appId,
            plan: plan,
            planName: req.requestedPlanName,
            startAt: now,
            expiresAt: expiresAt,
            status: 'ACTIVE',
            issuedAt: now,
            requestId: req.id,
            adminNotes: adminNotes || ''
        };

        // Sign the license
        rawLicense.signature = signLicense(rawLicense);

        // Store license
        this.data.licenses[licenseId] = rawLicense;

        // Update Request
        req.status = 'APPROVED';
        req.grantedPlan = plan;
        req.grantedDays = days;
        req.issuedLicenseId = licenseId;
        req.reviewedAt = now;
        req.adminNotes = adminNotes || '';

        // Update Device
        const device = this.getDevice(req.deviceId);
        if (device) {
            device.activeLicenseId = licenseId;
            device.status = 'ACTIVE';
            device.lastSeenAt = now;
        }

        this.logAudit('REQUEST_APPROVED', `Request ${requestId} approved. License ${licenseId} issued for ${days} days`, req.deviceId);
        this.save();

        return {
            request: req,
            license: rawLicense
        };
    }

    rejectRequest(requestId, reason) {
        const req = this.getRequestById(requestId);
        if (!req) throw new Error('الطلب غير موجود');

        const now = Date.now();
        req.status = 'REJECTED';
        req.rejectionReason = reason || 'طلب مرفوض من الإدارة';
        req.reviewedAt = now;

        this.logAudit('REQUEST_REJECTED', `Request ${requestId} rejected. Reason: ${req.rejectionReason}`, req.deviceId);
        this.save();
        return req;
    }

    // ──────────────── Licenses Management ────────────────

    getActiveLicenseForDevice(deviceId) {
        if (!deviceId) return null;
        const now = Date.now();
        const device = this.data.devices[deviceId];
        let license = (device && device.activeLicenseId) ? this.data.licenses[device.activeLicenseId] : null;

        // If not found by activeLicenseId, search across all licenses by deviceId
        if (!license) {
            license = Object.values(this.data.licenses || {}).find(l => 
                l.deviceId === deviceId && l.status === 'ACTIVE' && (l.expiresAt === 0 || l.expiresAt > now)
            );
            if (license && device) {
                device.activeLicenseId = license.id;
                device.status = 'ACTIVE';
            }
        }

        if (!license) return null;

        if (license.status === 'ACTIVE' && license.expiresAt > 0 && now > license.expiresAt) {
            license.status = 'EXPIRED';
            if (device) device.status = 'EXPIRED';
            this.save();
        }

        return license;
    }

    getAllLicenses() {
        const now = Date.now();
        return Object.values(this.data.licenses).map(lic => {
            const isExpired = lic.expiresAt > 0 && now > lic.expiresAt;
            return {
                ...lic,
                isExpired,
                status: isExpired && lic.status === 'ACTIVE' ? 'EXPIRED' : lic.status
            };
        });
    }

    updateLicense(licenseId, { action, additionalDays }) {
        const license = this.data.licenses[licenseId];
        if (!license) throw new Error('الترخيص غير موجود');

        const now = Date.now();

        if (action === 'EXTEND') {
            const days = Number(additionalDays) || 30;
            const currentExp = Math.max(now, license.expiresAt || now);
            license.expiresAt = currentExp + (days * 24 * 60 * 60 * 1000);
            license.status = 'ACTIVE';
            // Re-sign with new expiration
            license.signature = signLicense(license);

            const device = this.getDevice(license.deviceId);
            if (device) device.status = 'ACTIVE';

            this.logAudit('LICENSE_EXTENDED', `License ${licenseId} extended by ${days} days`, license.deviceId);
        } else if (action === 'SUSPEND') {
            license.status = 'SUSPENDED';
            const device = this.getDevice(license.deviceId);
            if (device) device.status = 'SUSPENDED';
            this.logAudit('LICENSE_SUSPENDED', `License ${licenseId} suspended`, license.deviceId);
        } else if (action === 'REVOKE') {
            license.status = 'REVOKED';
            const device = this.getDevice(license.deviceId);
            if (device) {
                device.status = 'REVOKED';
                device.activeLicenseId = null;
            }
            this.logAudit('LICENSE_REVOKED', `License ${licenseId} revoked`, license.deviceId);
        } else if (action === 'REACTIVATE') {
            license.status = 'ACTIVE';
            const device = this.getDevice(license.deviceId);
            if (device) {
                device.status = 'ACTIVE';
                device.activeLicenseId = license.id;
            }
            this.logAudit('LICENSE_REACTIVATED', `License ${licenseId} reactivated`, license.deviceId);
        }

        this.save();
        return license;
    }

    issueLicenseByPairingCode({ pairingCode, plan, days, adminNotes }) {
        if (!pairingCode) {
            throw new Error('يرجى إدخال رمز الاقتران');
        }
        const verify = this.getDeviceByPairingCode(pairingCode);
        if (!verify || verify.error) {
            throw new Error(verify ? verify.message : 'كود الربط غير موجود أو منتهي الصلاحية');
        }

        const { device } = verify;
        const now = Date.now();
        const durationDays = Number(days) || 30;
        const licensePlan = plan || 'month';

        const PLAN_MAP = {
            'month': { name: 'اشتراك شهر' },
            '6months': { name: 'اشتراك 6 أشهر' },
            'year': { name: 'اشتراك سنة' },
            'lifetime': { name: 'اشتراك دائم' }
        };
        const planName = PLAN_MAP[licensePlan] ? PLAN_MAP[licensePlan].name : licensePlan;

        const licenseId = `LIC-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
        const isLifetime = licensePlan === 'lifetime' || durationDays >= 36500;
        const expiresAt = isLifetime ? 0 : now + (durationDays * 24 * 60 * 60 * 1000);

        const rawLicense = {
            id: licenseId,
            deviceId: device.deviceId,
            pairingCode: pairingCode.trim().toUpperCase(),
            appId: device.appId,
            plan: licensePlan,
            planName: planName,
            startAt: now,
            expiresAt: expiresAt,
            status: 'ACTIVE',
            issuedAt: now,
            requestId: null,
            adminNotes: adminNotes || 'إصدار مباشر عبر رمز الاقتران'
        };

        rawLicense.signature = signLicense(rawLicense);

        this.data.licenses[licenseId] = rawLicense;
        const actualDev = this.getDevice(device.deviceId);
        if (actualDev) {
            actualDev.activeLicenseId = licenseId;
            actualDev.status = 'ACTIVE';
            actualDev.lastSeenAt = now;
        }

        // If there was any pending request for this device, mark it approved as well
        const pending = this.data.subscription_requests.find(
            r => (r.deviceId === device.deviceId || r.pairingCode === pairingCode.trim().toUpperCase()) && r.status === 'PENDING'
        );
        if (pending) {
            pending.status = 'APPROVED';
            pending.grantedPlan = licensePlan;
            pending.grantedDays = durationDays;
            pending.issuedLicenseId = licenseId;
            pending.reviewedAt = now;
            pending.adminNotes = adminNotes || 'تم التفعيل عبر رمز الاقتران المباشر';
        }

        this.logAudit('LICENSE_ISSUED_DIRECT', `License ${licenseId} issued directly via pairing code ${pairingCode} for ${durationDays} days`, device.deviceId);
        this.save();

        return {
            license: rawLicense,
            device: actualDev || device
        };
    }

    // ──────────────── Dashboard Stats ────────────────

    getDashboardStats() {
        const now = Date.now();
        const devices = Object.values(this.data.devices);
        const licenses = Object.values(this.data.licenses);
        const requests = this.data.subscription_requests;

        const totalDevices = devices.length;
        const activeLicenses = licenses.filter(l => l.status === 'ACTIVE' && (l.expiresAt === 0 || l.expiresAt > now)).length;
        const expiredLicenses = licenses.filter(l => l.status === 'EXPIRED' || (l.expiresAt > 0 && l.expiresAt <= now)).length;
        const pendingRequests = requests.filter(r => r.status === 'PENDING').length;
        const rejectedRequests = requests.filter(r => r.status === 'REJECTED').length;
        const approvedRequests = requests.filter(r => r.status === 'APPROVED').length;

        const totalTrialOpsUsed = devices.reduce((sum, d) => sum + (d.usedFreeOps || 0), 0);

        return {
            totalDevices,
            activeLicenses,
            expiredLicenses,
            pendingRequests,
            rejectedRequests,
            approvedRequests,
            totalTrialOpsUsed,
            serverTime: now
        };
    }

    logAudit(action, details, deviceId = null) {
        this.data.audit_logs.unshift({
            id: `LOG-${Date.now().toString(36)}`,
            action,
            details,
            deviceId,
            timestamp: Date.now()
        });
        if (this.data.audit_logs.length > 500) {
            this.data.audit_logs = this.data.audit_logs.slice(0, 500);
        }
    }
}

module.exports = new Database();
