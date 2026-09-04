const assert = require('assert');
const { signLicense, verifyLicense, generatePairingCode } = require('./cryptoSigner');
const db = require('./db');

console.log('🧪 Starting Jeep Card Backend Tests...');

// 1. Test Crypto Signer
console.log('1. Testing Crypto Signer...');
const mockLicense = {
    id: 'LIC-TEST-001',
    deviceId: 'DEV-1234567890ABCDEF',
    appId: 'com.kareemtech.cardSeller',
    plan: 'month',
    startAt: 1788480000000,
    expiresAt: 1791072000000
};

const sig = signLicense(mockLicense);
assert.ok(sig && sig.length === 64, 'Signature must be a 64-character hex string');
mockLicense.signature = sig;

assert.strictEqual(verifyLicense(mockLicense), true, 'License signature must be valid');

// Tamper test
const tamperedLicense = { ...mockLicense, expiresAt: 1999999999999 };
assert.strictEqual(verifyLicense(tamperedLicense), false, 'Tampered license must fail verification');

console.log('✓ Crypto signer passed!');

// 2. Test Pairing Code Generation
console.log('2. Testing Pairing Code Generation...');
const code = generatePairingCode();
assert.match(code, /^[2-9A-Z]{4}-[2-9A-Z]{4}$/, 'Pairing code must match format XXXX-XXXX');
console.log('✓ Pairing code generated:', code);

// 3. Test Device Registration & Anti-Reinstall Ops Protection
console.log('3. Testing Anti-Reinstall Free Ops Protection...');
const testDeviceId = 'DEVICE_TEST_' + Date.now();
const dev1 = db.registerOrGetDevice(testDeviceId, 'com.kareemtech.cardSeller', { model: 'Samsung S24' });
assert.strictEqual(dev1.usedFreeOps, 0, 'New device must start with 0 used ops');

// Consume 15 operations
db.updateDeviceOps(testDeviceId, 15);
const devAfterOps = db.getDevice(testDeviceId);
assert.strictEqual(devAfterOps.usedFreeOps, 15, 'Used ops must be 15');

// Simulate App Reinstallation (device registers again)
const devReinstall = db.registerOrGetDevice(testDeviceId, 'com.kareemtech.cardSeller');
assert.strictEqual(devReinstall.usedFreeOps, 15, 'CRITICAL: Reinstalled app must preserve 15 used ops!');
console.log('✓ Anti-reinstall protection verified! (Preserved 15/50 ops)');

// 4. Test Pairing & Request Submission
console.log('4. Testing Pairing Code & Request Creation...');
const pairing = db.createOrGetPairingCode(testDeviceId);
assert.ok(pairing.code, 'Must create pairing code');

const verifyResult = db.getDeviceByPairingCode(pairing.code);
assert.ok(verifyResult && verifyResult.device, 'Pairing code lookup must return device');
assert.strictEqual(verifyResult.device.usedFreeOps, 15);
assert.strictEqual(verifyResult.device.freeOpsRemaining, 35);

const newReq = db.createSubscriptionRequest({
    pairingCode: pairing.code,
    requestedPlan: '6months',
    customerName: 'شبكة النورس',
    customerPhone: '771234567',
    notes: 'تحويل الكريمي 5000'
});
assert.ok(newReq.id, 'Request must have an ID');
assert.strictEqual(newReq.status, 'PENDING');
console.log('✓ Request created:', newReq.id);

// 5. Test Owner Approval with Custom Days & Plan
console.log('5. Testing Owner Approval with Custom Days (45 days)...');
const approvalResult = db.approveRequest(newReq.id, {
    grantedPlan: 'month',
    grantedDays: 45,
    adminNotes: 'تم منح 45 يوم كعرض خاص'
});

assert.strictEqual(approvalResult.request.status, 'APPROVED');
assert.strictEqual(approvalResult.request.grantedDays, 45);
assert.ok(approvalResult.license, 'Must issue license');
assert.strictEqual(verifyLicense(approvalResult.license), true, 'Issued license must have valid cryptographic signature');

const devAfterLicense = db.getDevice(testDeviceId);
assert.strictEqual(devAfterLicense.status, 'ACTIVE', 'Device status must be ACTIVE after approval');
console.log('✓ Owner approval and signed license issuance verified!');

console.log('\n🎉 ALL BACKEND TESTS PASSED SUCCESSFULLY!');
