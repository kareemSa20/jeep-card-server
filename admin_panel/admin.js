document.addEventListener('DOMContentLoaded', () => {
    // Auth State
    let adminToken = localStorage.getItem('jeep_admin_token') || null;

    // Elements
    const loginOverlay = document.getElementById('login-overlay');
    const loginForm = document.getElementById('login-form');
    const pinInput = document.getElementById('pin-input');
    const loginAlert = document.getElementById('login-alert');
    const dashboardApp = document.getElementById('dashboard-app');
    const logoutBtn = document.getElementById('logout-btn');
    const refreshBtn = document.getElementById('refresh-all-btn');

    // Navigation Tabs
    const navTabs = document.querySelectorAll('.nav-tab');
    const tabContents = document.querySelectorAll('.tab-content');
    const pageTitle = document.getElementById('page-title');
    const pendingBadge = document.getElementById('pending-badge');

    // Decision Modal Elements
    const decisionModal = document.getElementById('decision-modal');
    const approveView = document.getElementById('approve-view');
    const rejectView = document.getElementById('reject-view');
    const tabBtnApprove = document.getElementById('tab-btn-approve');
    const tabBtnReject = document.getElementById('tab-btn-reject');
    let activeModalRequest = null;

    // License Modal Elements
    const licenseModal = document.getElementById('license-modal');
    let activeModalLicenseId = null;

    // ──────────────── Auth Flow ────────────────
    if (adminToken) {
        verifyAuth();
    }

    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const pin = pinInput.value.trim();
        loginAlert.classList.add('hidden');

        try {
            const res = await fetch('/api/admin/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pin })
            });

            const data = await res.json();
            if (!res.ok || !data.success) {
                loginAlert.textContent = data.message || 'رمز الدخول غير صحيح';
                loginAlert.classList.remove('hidden');
                return;
            }

            adminToken = data.token;
            localStorage.setItem('jeep_admin_token', adminToken);
            showDashboard();
            loadAllData();
        } catch (err) {
            loginAlert.textContent = 'تعذر الاتصال بالخادم';
            loginAlert.classList.remove('hidden');
        }
    });

    logoutBtn.addEventListener('click', () => {
        localStorage.removeItem('jeep_admin_token');
        adminToken = null;
        dashboardApp.classList.add('hidden');
        loginOverlay.classList.remove('hidden');
        pinInput.value = '';
    });

    async function verifyAuth() {
        try {
            const res = await fetch('/api/admin/dashboard', {
                headers: { 'Authorization': `Bearer ${adminToken}` }
            });
            if (res.ok) {
                showDashboard();
                loadAllData();
            } else {
                localStorage.removeItem('jeep_admin_token');
                adminToken = null;
            }
        } catch (e) {
            console.error('Auth verification error:', e);
        }
    }

    function showDashboard() {
        loginOverlay.classList.add('hidden');
        dashboardApp.classList.remove('hidden');
    }

    // ──────────────── Tab Navigation ────────────────
    window.switchTab = function(tabKey) {
        navTabs.forEach(t => {
            if (t.getAttribute('data-tab') === tabKey) {
                t.classList.add('active');
            } else {
                t.classList.remove('active');
            }
        });

        tabContents.forEach(c => {
            if (c.id === `tab-${tabKey}`) {
                c.classList.add('active');
            } else {
                c.classList.remove('active');
            }
        });

        const titles = {
            overview: 'نظرة عامة وإحصائيات',
            requests: 'إدارة طلبات الاشتراكات',
            licenses: 'الاشتراكات والتراخيص الصادرة',
            devices: 'أسطول الأجهزة المسجلة'
        };
        pageTitle.textContent = titles[tabKey] || 'لوحة التحكم';

        if (tabKey === 'requests') loadRequests();
        if (tabKey === 'licenses') loadLicenses();
        if (tabKey === 'devices') loadDevices();
    };

    navTabs.forEach(tab => {
        tab.addEventListener('click', () => {
            switchTab(tab.getAttribute('data-tab'));
        });
    });

    refreshBtn.addEventListener('click', loadAllData);

    // ──────────────── Data Fetching ────────────────
    function loadAllData() {
        loadDashboardStats();
        loadRequests();
        loadLicenses();
        loadDevices();
    }

    async function loadDashboardStats() {
        if (!adminToken) return;
        try {
            const res = await fetch('/api/admin/dashboard', {
                headers: { 'Authorization': `Bearer ${adminToken}` }
            });
            const data = await res.json();
            if (res.ok && data.success) {
                const s = data.stats;
                document.getElementById('stat-pending-requests').textContent = s.pendingRequests;
                document.getElementById('stat-active-licenses').textContent = s.activeLicenses;
                document.getElementById('stat-total-devices').textContent = s.totalDevices;
                document.getElementById('stat-total-trial-ops').textContent = s.totalTrialOpsUsed;

                if (s.pendingRequests > 0) {
                    pendingBadge.textContent = s.pendingRequests;
                    pendingBadge.classList.remove('hidden');
                } else {
                    pendingBadge.classList.add('hidden');
                }

                if (s.serverTime) {
                    const d = new Date(s.serverTime);
                    document.getElementById('server-time-display').textContent = d.toLocaleString('ar-YE');
                }
            }
        } catch (e) {
            console.error('Failed to load stats:', e);
        }
    }

    // ──────────────── Requests Management ────────────────
    let currentRequestsFilter = 'ALL';
    const filterBtns = document.querySelectorAll('.filter-btn');

    filterBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            filterBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentRequestsFilter = btn.getAttribute('data-status');
            loadRequests();
        });
    });

    async function loadRequests() {
        if (!adminToken) return;
        try {
            const url = currentRequestsFilter === 'ALL' ? '/api/admin/requests' : `/api/admin/requests?status=${currentRequestsFilter}`;
            const res = await fetch(url, {
                headers: { 'Authorization': `Bearer ${adminToken}` }
            });
            const data = await res.json();
            if (res.ok && data.success) {
                renderRequestsTable(data.requests);
                renderQuickRequests(data.requests.filter(r => r.status === 'PENDING').slice(0, 5));
            }
        } catch (e) {
            console.error('Failed to load requests:', e);
        }
    }

    function renderRequestsTable(requests) {
        const tbody = document.getElementById('all-requests-tbody');
        if (!requests || requests.length === 0) {
            tbody.innerHTML = `<tr><td colspan="9" class="empty-state">لا توجد طلبات تطابق الفلتر المختار.</td></tr>`;
            return;
        }

        tbody.innerHTML = requests.map(r => `
            <tr>
                <td><strong>${r.id}</strong></td>
                <td>${escapeHtml(r.customerName)}</td>
                <td><a href="https://wa.me/${cleanPhone(r.customerPhone)}" target="_blank" style="color: #38bdf8; text-decoration:none;">${escapeHtml(r.customerPhone)}</a></td>
                <td><span style="font-size:11px; font-family:monospace;">${r.hardwareModel || r.deviceId.substring(0, 10) + '...'}</span></td>
                <td><code>${r.pairingCode}</code></td>
                <td><span class="badge ${r.requestedPlan === 'lifetime' ? 'badge-approved' : 'badge-pending'}">${r.requestedPlanName || r.requestedPlan}</span></td>
                <td>${getStatusBadge(r.status)}</td>
                <td>${formatDate(r.createdAt)}</td>
                <td>
                    <button class="btn btn-primary btn-sm" onclick="openDecisionModal('${r.id}')">
                        ${r.status === 'PENDING' ? '⚡ مراجعة واتخاذ قرار' : 'عرض التفاصيل'}
                    </button>
                </td>
            </tr>
        `).join('');
    }

    function renderQuickRequests(requests) {
        const tbody = document.getElementById('quick-requests-tbody');
        if (!requests || requests.length === 0) {
            tbody.innerHTML = `<tr><td colspan="7" class="empty-state">لا توجد طلبات معلقة حالياً ✓</td></tr>`;
            return;
        }

        tbody.innerHTML = requests.map(r => `
            <tr>
                <td><strong>${r.id}</strong></td>
                <td>${escapeHtml(r.customerName)}</td>
                <td>${escapeHtml(r.customerPhone)}</td>
                <td>${r.hardwareModel || 'Android'}</td>
                <td><span class="badge badge-pending">${r.requestedPlanName}</span></td>
                <td>${formatDate(r.createdAt)}</td>
                <td>
                    <button class="btn btn-primary btn-sm" onclick="openDecisionModal('${r.id}')">
                        ⚡ فتح الطلب
                    </button>
                </td>
            </tr>
        `).join('');
    }

    // ──────────────── Decision Modal Logic ────────────────
    window.openDecisionModal = async function(requestId) {
        try {
            const res = await fetch('/api/admin/requests', {
                headers: { 'Authorization': `Bearer ${adminToken}` }
            });
            const data = await res.json();
            const req = data.requests.find(r => r.id === requestId);
            if (!req) return;

            activeModalRequest = req;
            document.getElementById('modal-req-title').textContent = `مراجعة الطلب ${req.id}`;
            document.getElementById('modal-cust-name').textContent = req.customerName;
            document.getElementById('modal-cust-phone').textContent = req.customerPhone;
            document.getElementById('modal-device-id').textContent = req.deviceId;
            document.getElementById('modal-pairing-code').textContent = req.pairingCode;
            document.getElementById('modal-requested-plan').textContent = `${req.requestedPlanName} (${req.requestedPrice})`;
            document.getElementById('modal-notes').textContent = req.notes || 'لا توجد ملاحظات';

            // Preset grant plan & days based on requested plan
            const planSelect = document.getElementById('modal-grant-plan');
            const daysInput = document.getElementById('modal-grant-days');
            planSelect.value = req.requestedPlan || 'month';
            daysInput.value = req.requestedDays || 30;

            setDecisionMode('APPROVE');
            decisionModal.classList.remove('hidden');
        } catch (e) {
            console.error('Error opening modal:', e);
        }
    };

    window.closeDecisionModal = function() {
        decisionModal.classList.add('hidden');
        activeModalRequest = null;
    };

    window.setDecisionMode = function(mode) {
        if (mode === 'APPROVE') {
            tabBtnApprove.classList.add('active');
            tabBtnReject.classList.remove('active');
            approveView.classList.remove('hidden');
            rejectView.classList.add('hidden');
        } else {
            tabBtnReject.classList.add('active');
            tabBtnApprove.classList.remove('active');
            rejectView.classList.remove('hidden');
            approveView.classList.add('hidden');
        }
    };

    window.onPlanSelectChanged = function() {
        const plan = document.getElementById('modal-grant-plan').value;
        const daysInput = document.getElementById('modal-grant-days');
        const defaultDays = {
            'month': 30,
            '6months': 180,
            'year': 365,
            'lifetime': 36500,
            'custom': 45
        };
        daysInput.value = defaultDays[plan] || 30;
    };

    window.executeApprove = async function() {
        if (!activeModalRequest) return;
        const grantPlan = document.getElementById('modal-grant-plan').value;
        const grantDays = document.getElementById('modal-grant-days').value;
        const adminNotes = document.getElementById('modal-admin-notes').value.trim();

        try {
            const res = await fetch(`/api/admin/requests/${encodeURIComponent(activeModalRequest.id)}/approve`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${adminToken}`
                },
                body: JSON.stringify({
                    grantedPlan: grantPlan,
                    grantedDays: grantDays,
                    adminNotes: adminNotes
                })
            });

            const data = await res.json();
            if (res.ok && data.success) {
                alert(`✓ تم تفعيل الاشتراك بنجاح للطلب ${activeModalRequest.id} وإصدار الترخيص!`);
                closeDecisionModal();
                loadAllData();
            } else {
                alert(data.message || 'حدث خطأ أثناء تفعيل الاشتراك');
            }
        } catch (e) {
            alert('تعذر الاتصال بالخادم');
        }
    };

    window.executeReject = async function() {
        if (!activeModalRequest) return;
        const reason = document.getElementById('modal-reject-reason').value;

        try {
            const res = await fetch(`/api/admin/requests/${encodeURIComponent(activeModalRequest.id)}/reject`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${adminToken}`
                },
                body: JSON.stringify({ reason })
            });

            const data = await res.json();
            if (res.ok && data.success) {
                alert(`✓ تم رفض الطلب ${activeModalRequest.id}`);
                closeDecisionModal();
                loadAllData();
            } else {
                alert(data.message || 'حدث خطأ أثناء رفض الطلب');
            }
        } catch (e) {
            alert('تعذر الاتصال بالخادم');
        }
    };

    // ──────────────── Licenses Management ────────────────
    async function loadLicenses() {
        if (!adminToken) return;
        try {
            const res = await fetch('/api/admin/licenses', {
                headers: { 'Authorization': `Bearer ${adminToken}` }
            });
            const data = await res.json();
            if (res.ok && data.success) {
                renderLicensesTable(data.licenses);
            }
        } catch (e) {
            console.error('Failed to load licenses:', e);
        }
    }

    function renderLicensesTable(licenses) {
        const tbody = document.getElementById('licenses-tbody');
        if (!licenses || licenses.length === 0) {
            tbody.innerHTML = `<tr><td colspan="9" class="empty-state">لا توجد تراخيص مصدرة حتى الآن.</td></tr>`;
            return;
        }

        tbody.innerHTML = licenses.map(l => `
            <tr>
                <td><code>${l.id}</code></td>
                <td><strong style="color:#38bdf8; font-family:monospace; font-size:13px;">${l.pairingCode || '-'}</strong></td>
                <td><span style="font-family:monospace; font-size:11px;">${l.deviceId.substring(0, 12)}...</span></td>
                <td><strong>${l.planName || l.plan}</strong></td>
                <td>${formatDate(l.startAt)}</td>
                <td>${l.expiresAt === 0 ? '<span class="badge badge-approved">مدى الحياة</span>' : formatDate(l.expiresAt)}</td>
                <td>${getStatusBadge(l.status)}</td>
                <td><code style="font-size:10px; color:#94a3b8;">${l.signature ? l.signature.substring(0, 14) + '...' : '-'}</code></td>
                <td>
                    <button class="btn btn-secondary btn-sm" onclick="openLicenseModal('${l.id}')">
                        ⚙️ إدارة الترخيص
                    </button>
                </td>
            </tr>
        `).join('');
    }

    window.openLicenseModal = function(licId) {
        activeModalLicenseId = licId;
        document.getElementById('license-modal-title').textContent = `إدارة الترخيص ${licId}`;
        licenseModal.classList.remove('hidden');
    };

    window.closeLicenseModal = function() {
        licenseModal.classList.add('hidden');
        activeModalLicenseId = null;
    };

    window.setExtendDays = function(days) {
        document.getElementById('license-extend-days').value = days;
    };

    // ──────────────── Direct License Issuance Modal by Pairing Code ────────────────
    window.openDirectLicenseModal = function() {
        const modal = document.getElementById('direct-license-modal');
        if (modal) modal.classList.remove('hidden');
        const codeInput = document.getElementById('modal-lic-code');
        if (codeInput) {
            codeInput.value = '';
            codeInput.focus();
        }
    };

    window.closeDirectLicenseModal = function() {
        const modal = document.getElementById('direct-license-modal');
        if (modal) modal.classList.add('hidden');
    };

    window.handleModalPlanChange = function() {
        const plan = document.getElementById('modal-lic-plan').value;
        const daysInput = document.getElementById('modal-lic-days');
        if (!daysInput) return;
        if (plan === 'month') daysInput.value = 30;
        else if (plan === '6months') daysInput.value = 180;
        else if (plan === 'year') daysInput.value = 365;
        else if (plan === 'lifetime') daysInput.value = 36500;
    };

    window.submitModalDirectLicense = async function() {
        if (!adminToken) return;
        const codeInput = document.getElementById('modal-lic-code');
        const planSelect = document.getElementById('modal-lic-plan');
        const daysInput = document.getElementById('modal-lic-days');
        const notesInput = document.getElementById('modal-lic-notes');

        const code = codeInput ? codeInput.value.trim() : '';
        const plan = planSelect ? planSelect.value : 'month';
        const days = parseInt(daysInput ? daysInput.value : '30', 10) || 30;
        const notes = notesInput ? notesInput.value.trim() : '';

        if (!code) {
            alert('يرجى إدخال كود الربط الخاص بجهاز العميل.');
            return;
        }

        const btn = document.getElementById('btn-modal-issue-license');
        if (btn) {
            btn.disabled = true;
            btn.textContent = 'جارٍ التفعيل...';
        }

        try {
            const res = await fetch('/api/admin/licenses/create-by-code', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${adminToken}`
                },
                body: JSON.stringify({
                    pairingCode: code,
                    plan: plan,
                    days: days,
                    adminNotes: notes
                })
            });

            const data = await res.json();
            if (res.ok && data.success) {
                alert(`✓ ${data.message}\nمعرف الترخيص الجديد: ${data.license ? data.license.id : ''}`);
                closeDirectLicenseModal();
                loadAllData();
            } else {
                alert(`❌ تعذر التفعيل: ${data.message || 'حدث خطأ'}`);
            }
        } catch (e) {
            alert('تعذر الاتصال بالخادم.');
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.textContent = 'تفعيل';
            }
        }
    };

    window.handleDirectPlanChange = function() {
        const plan = document.getElementById('direct-lic-plan').value;
        const daysInput = document.getElementById('direct-lic-days');
        if (plan === 'month') daysInput.value = 30;
        else if (plan === '6months') daysInput.value = 180;
        else if (plan === 'year') daysInput.value = 365;
        else if (plan === 'lifetime') daysInput.value = 36500;
    };

    window.resetDirectLicenseForm = function() {
        document.getElementById('direct-lic-code').value = '';
        document.getElementById('direct-lic-plan').value = 'month';
        document.getElementById('direct-lic-days').value = 30;
        document.getElementById('direct-lic-notes').value = '';
    };

    window.submitDirectLicense = async function() {
        if (!adminToken) return;
        const code = document.getElementById('direct-lic-code').value.trim();
        const plan = document.getElementById('direct-lic-plan').value;
        const days = parseInt(document.getElementById('direct-lic-days').value, 10) || 30;
        const notes = document.getElementById('direct-lic-notes').value.trim();

        if (!code) {
            alert('يرجى إدخال كود اقتران الجهاز (Pairing Code).');
            return;
        }

        const btn = document.getElementById('btn-direct-issue-license');
        btn.disabled = true;
        btn.innerHTML = '<span>⏳</span> جارٍ التفعيل والإصدار...';

        try {
            const res = await fetch('/api/admin/licenses/create-by-code', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${adminToken}`
                },
                body: JSON.stringify({
                    pairingCode: code,
                    plan: plan,
                    days: days,
                    adminNotes: notes
                })
            });

            const data = await res.json();
            if (res.ok && data.success) {
                alert(`✓ ${data.message}\nمعرف الترخيص: ${data.license ? data.license.id : ''}`);
                resetDirectLicenseForm();
                loadAllData();
            } else {
                alert(`❌ فشل تفعيل الترخيص: ${data.message || 'حدث خطأ غير معروف'}`);
            }
        } catch (e) {
            alert('تعذر الاتصال بالخادم، يرجى التأكد من تشغيل السيرفر.');
        } finally {
            btn.disabled = false;
            btn.innerHTML = '<span>🔑</span> تفعيل وإصدار الترخيص الآن';
        }
    };

    window.executeLicenseAction = async function(action) {
        if (!activeModalLicenseId) return;
        const addDays = document.getElementById('extend-days-input').value;

        try {
            const res = await fetch(`/api/admin/licenses/${encodeURIComponent(activeModalLicenseId)}/update`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${adminToken}`
                },
                body: JSON.stringify({ action, additionalDays: addDays })
            });

            const data = await res.json();
            if (res.ok && data.success) {
                alert('✓ تم تحديث الترخيص بنجاح');
                closeLicenseModal();
                loadAllData();
            } else {
                alert(data.message || 'حدث خطأ');
            }
        } catch (e) {
            alert('تعذر الاتصال بالخادم');
        }
    };

    // ──────────────── Devices Fleet ────────────────
    async function loadDevices() {
        if (!adminToken) return;
        try {
            const res = await fetch('/api/admin/devices', {
                headers: { 'Authorization': `Bearer ${adminToken}` }
            });
            const data = await res.json();
            if (res.ok && data.success) {
                renderDevicesTable(data.devices);
            }
        } catch (e) {
            console.error('Failed to load devices:', e);
        }
    }

    function renderDevicesTable(devices) {
        const countEl = document.getElementById('total-devices-count');
        if (countEl) countEl.textContent = devices ? devices.length : 0;

        const tbody = document.getElementById('devices-tbody');
        if (!devices || devices.length === 0) {
            tbody.innerHTML = `<tr><td colspan="9" class="empty-state">لا توجد أجهزة مسجلة حتى الآن.</td></tr>`;
            return;
        }

        tbody.innerHTML = devices.map(d => `
            <tr>
                <td><code>${d.deviceId}</code></td>
                <td><strong>${d.hardwareModel || 'Android'}</strong></td>
                <td><strong style="color:#38bdf8; font-family:monospace; font-size:13px;">${d.pairingCode || '-'}</strong></td>
                <td>${d.license ? `<span class="badge badge-approved">${d.license.planName || d.license.plan}</span>` : '<span class="badge badge-pending">تجريبي</span>'}</td>
                <td><span style="color:#f87171; font-weight:800;">${d.usedFreeOps} عملية</span></td>
                <td><span style="color:#34d399; font-weight:800;">${d.freeOpsRemaining} متبقية</span></td>
                <td>${getStatusBadge(d.status)}</td>
                <td>${formatDate(d.lastSeenAt)}</td>
                <td>
                    <button class="btn btn-secondary btn-sm" onclick="adjustDeviceOps('${d.deviceId}', ${d.usedFreeOps})">
                        ✏️ تعديل العداد
                    </button>
                </td>
            </tr>
        `).join('');
    }

    window.adjustDeviceOps = async function(deviceId, currentOps) {
        const val = prompt(`تعديل عدد العمليات المستهلكة للجهاز ${deviceId}\n(القيمة الحالية: ${currentOps} من 50):`, "0");
        if (val === null) return;
        const num = parseInt(val, 10);
        if (isNaN(num) || num < 0 || num > 50) {
            alert('يرجى إدخال رقم بين 0 و 50');
            return;
        }

        try {
            const res = await fetch(`/api/admin/devices/${encodeURIComponent(deviceId)}/adjust-ops`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${adminToken}`
                },
                body: JSON.stringify({ usedOps: num })
            });

            const data = await res.json();
            if (res.ok && data.success) {
                alert('✓ تم تعديل عداد العمليات بنجاح');
                loadAllData();
            }
        } catch (e) {
            alert('تعذر الاتصال بالخادم');
        }
    };

    // ──────────────── Helpers ────────────────
    function getStatusBadge(status) {
        const map = {
            'PENDING': '<span class="badge badge-pending">بانتظار المراجعة</span>',
            'APPROVED': '<span class="badge badge-approved">مقبول</span>',
            'ACTIVE': '<span class="badge badge-approved">نشط / مفعل</span>',
            'REJECTED': '<span class="badge badge-rejected">مرفوض</span>',
            'EXPIRED': '<span class="badge badge-expired">منتهي</span>',
            'EXHAUSTED': '<span class="badge badge-expired">انتهت الـ 50</span>',
            'TRIAL': '<span class="badge badge-pending">تجريبي</span>',
            'SUSPENDED': '<span class="badge badge-suspended">معلق</span>',
            'REVOKED': '<span class="badge badge-rejected">ملغي</span>'
        };
        return map[status] || `<span class="badge badge-pending">${status}</span>`;
    }

    function formatDate(ts) {
        if (!ts) return '-';
        const d = new Date(ts);
        return d.toLocaleDateString('ar-YE', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    }

    function escapeHtml(str) {
        if (!str) return '';
        return str.replace(/[&<>'"]/g, tag => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            "'": '&#39;',
            '"': '&quot;'
        }[tag] || tag));
    }

    function cleanPhone(p) {
        if (!p) return '';
        let cleaned = p.replace(/[^0-9]/g, '');
        if (cleaned.startsWith('0')) cleaned = cleaned.substring(1);
        if (!cleaned.startsWith('967')) cleaned = '967' + cleaned;
        return cleaned;
    }

    // Auto refresh every 10 seconds
    setInterval(() => {
        if (adminToken && !decisionModal.classList.contains('hidden')) return;
        if (adminToken) {
            loadDashboardStats();
            if (document.getElementById('tab-requests').classList.contains('active')) {
                loadRequests();
            }
        }
    }, 10000);
});
