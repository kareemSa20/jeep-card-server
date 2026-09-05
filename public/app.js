/**
 * جيب كارت (Jeep Card) - التطبيق التفاعلي الموحد
 * يدعم الصفحة الرئيسية (index.html)، صفحة ربط وتفعيل التطبيق (activate.html)،
 * وصفحة تأكيد ومتابعة الطلب (order.html).
 */
document.addEventListener('DOMContentLoaded', () => {
    // ──────────────── 1. Shared State & Utilities ────────────────
    const urlParams = new URLSearchParams(window.location.search);
    const planMap = {
        'month': { title: 'اشتراك شهر', price: '2,500 ريال يمني', days: 30 },
        '6months': { title: 'اشتراك 6 أشهر', price: '5,000 ريال يمني', days: 180 },
        'year': { title: 'اشتراك سنة كاملة', price: '10,000 ريال يمني', days: 365 },
        'lifetime': { title: 'اشتراك دائم', price: '50,000 ريال يمني', days: 36500 }
    };

    let currentDevice = null;
    try {
        const cachedDev = sessionStorage.getItem('jeep_device');
        if (cachedDev) currentDevice = JSON.parse(cachedDev);
    } catch (e) {}

    let selectedPlan = urlParams.get('plan') || sessionStorage.getItem('jeep_selected_plan') || '6months';
    if (!planMap[selectedPlan]) selectedPlan = '6months';
    let selectedPlanTitle = planMap[selectedPlan].title;
    let selectedPlanPrice = planMap[selectedPlan].price;

    let activeRequestId = sessionStorage.getItem('jeep_last_request_id') || null;
    let pollInterval = null;

    // Helper UI functions
    function showAlert(el, msg, type = 'info') {
        if (!el) return;
        el.textContent = msg;
        el.className = `alert-box alert-${type}`;
        el.classList.remove('hidden');
    }

    function hideAlert(el) {
        if (el) el.classList.add('hidden');
    }

    function setLoading(btn, spinner, textEl, loading, label) {
        if (!btn) return;
        btn.disabled = loading;
        if (spinner) {
            if (loading) spinner.classList.remove('hidden');
            else spinner.classList.add('hidden');
        }
        if (textEl) textEl.textContent = label;
    }

    // ──────────────── 2. Logic for Activate Page (activate.html) ────────────────
    const pairingInput = document.getElementById('pairing-code-input');
    const verifyBtn = document.getElementById('verify-btn');
    const pairingAlert = document.getElementById('pairing-alert');
    const deviceInfoCard = document.getElementById('device-info-card');
    const plansSection = document.getElementById('plans-section');
    const planCards = document.querySelectorAll('.plan-card');
    const proceedBanner = document.getElementById('proceed-banner');
    const goToOrderBtn = document.getElementById('go-to-order-btn');
    const step1 = document.getElementById('step-indicator-1');
    const step2 = document.getElementById('step-indicator-2');
    const summaryPlanText = document.getElementById('summary-plan-text');
    const summaryPriceText = document.getElementById('summary-price-text');

    if (pairingInput && verifyBtn) {
        const verifySpinner = verifyBtn.querySelector('.btn-spinner');
        const verifyText = verifyBtn.querySelector('.btn-text');

        // Restore cached code if available
        const savedCode = urlParams.get('code') || sessionStorage.getItem('jeep_pairing_code') || '';
        if (savedCode) {
            pairingInput.value = savedCode;
        }

        // Auto-format matching Android app: JC-XXXXXX (hyphen after 2 characters)
        pairingInput.addEventListener('input', (e) => {
            let raw = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
            let formatted = raw;
            if (raw.length > 2) {
                formatted = raw.substring(0, 2) + '-' + raw.substring(2, 8);
            }
            e.target.value = formatted;
        });

        pairingInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                verifyPairingCode();
            }
        });

        verifyBtn.addEventListener('click', verifyPairingCode);

        // Verification Handler
        async function verifyPairingCode() {
            const rawCode = pairingInput.value.trim().toUpperCase();
            const cleanCode = rawCode.replace(/[^A-Z0-9]/g, '');
            hideAlert(pairingAlert);

            if (!cleanCode || cleanCode.length < 6) {
                showAlert(pairingAlert, 'يرجى كتابة كود الربط الظاهر في التطبيق بالشكل JC-XXXXXX', 'error');
                return;
            }

            let code = rawCode;
            if (!code.includes('-') && cleanCode.length > 2) {
                code = cleanCode.substring(0, 2) + '-' + cleanCode.substring(2, 8);
            }

            setLoading(verifyBtn, verifySpinner, verifyText, true, 'جارٍ الفحص...');

            try {
                const res = await fetch('/api/web/verify-pairing', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ code })
                });

                const data = await res.json();
                setLoading(verifyBtn, verifySpinner, verifyText, false, 'التحقق من الكود');

                if (!res.ok || !data.success) {
                    showAlert(pairingAlert, data.message || 'كود الربط غير صحيح أو منتهي الصلاحية.', 'error');
                    if (deviceInfoCard) deviceInfoCard.classList.add('hidden');
                    return;
                }

                currentDevice = data.device;
                sessionStorage.setItem('jeep_device', JSON.stringify(data.device));
                sessionStorage.setItem('jeep_pairing_code', code);

                displayDeviceInfo(data.device);
                showAlert(pairingAlert, '✓ تم التعرف على التطبيق والجهاز بنجاح!', 'success');

                // Unlock Plans Section & Step 2
                if (plansSection) {
                    plansSection.classList.remove('disabled-section');
                }
                if (step1) step1.classList.add('active');
                if (step2) step2.classList.add('active');
                if (proceedBanner) proceedBanner.classList.remove('hidden');

                // Smooth scroll to plans
                setTimeout(() => {
                    if (plansSection) {
                        plansSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    }
                }, 300);

            } catch (err) {
                setLoading(verifyBtn, verifySpinner, verifyText, false, 'التحقق من الكود');
                showAlert(pairingAlert, 'تعذر الاتصال بالخادم، يرجى التأكد من تشغيل السيرفر.', 'error');
            }
        }

        function displayDeviceInfo(dev) {
            if (!deviceInfoCard) return;
            const appIdEl = document.getElementById('dev-app-id');
            const modelEl = document.getElementById('dev-model');
            const statusEl = document.getElementById('dev-status');
            const usedOpsEl = document.getElementById('dev-used-ops');
            const remOpsEl = document.getElementById('dev-remaining-ops');
            const fillEl = document.getElementById('trial-progress-fill');
            const textEl = document.getElementById('trial-progress-text');

            if (appIdEl) appIdEl.textContent = dev.appId || 'APP-IDENTIFIER';
            if (modelEl) modelEl.textContent = dev.hardwareModel || 'Android Device';

            if (statusEl) {
                if (dev.hasActiveLicense) {
                    statusEl.textContent = 'مفعل (نشط)';
                    statusEl.className = 'stat-value highlight-remaining';
                } else if (dev.usedFreeOps >= dev.totalFreeOpsLimit) {
                    statusEl.textContent = 'انتهت العمليات المجانية (50/50)';
                    statusEl.className = 'stat-value highlight-used';
                } else {
                    statusEl.textContent = 'غير مفعل (نسخة تجريبية)';
                    statusEl.className = 'stat-value status-badge';
                }
            }

            if (usedOpsEl) usedOpsEl.textContent = `${dev.usedFreeOps} عملية`;
            if (remOpsEl) remOpsEl.textContent = `${dev.freeOpsRemaining} عملية`;

            const total = dev.totalFreeOpsLimit || 50;
            const percent = Math.min(100, Math.round(((dev.usedFreeOps || 0) / total) * 100));
            if (fillEl) fillEl.style.width = `${percent}%`;
            if (textEl) textEl.textContent = `${dev.usedFreeOps || 0} / ${total} (${percent}%)`;

            deviceInfoCard.classList.remove('hidden');
        }

        // Auto-verify if code exists in cache
        if (savedCode && savedCode.replace(/[^A-Z0-9]/g, '').length >= 6) {
            verifyPairingCode();
        }

        // Plan Selection in activate.html
        if (planCards && planCards.length > 0) {
            // Apply selected plan from URL or storage
            applySelectedPlanUI(selectedPlan);

            planCards.forEach(card => {
                card.addEventListener('click', () => {
                    const planKey = card.getAttribute('data-plan');
                    if (planKey) {
                        applySelectedPlanUI(planKey);
                    }
                });
            });
        }

        function applySelectedPlanUI(planKey) {
            selectedPlan = planKey;
            sessionStorage.setItem('jeep_selected_plan', planKey);

            if (planMap[planKey]) {
                selectedPlanTitle = planMap[planKey].title;
                selectedPlanPrice = planMap[planKey].price;
                sessionStorage.setItem('jeep_selected_plan_title', selectedPlanTitle);
                sessionStorage.setItem('jeep_selected_plan_price', selectedPlanPrice);
            }

            planCards.forEach(c => {
                const btn = c.querySelector('.select-plan-btn');
                if (c.getAttribute('data-plan') === planKey) {
                    c.classList.add('selected');
                    if (btn) btn.textContent = 'الباقة المختارة ✓';
                } else {
                    c.classList.remove('selected');
                    if (btn) btn.textContent = 'اختيار هذه الباقة';
                }
            });

            if (summaryPlanText) summaryPlanText.textContent = selectedPlanTitle;
            if (summaryPriceText) summaryPriceText.textContent = selectedPlanPrice;
        }

        // Navigate to Order Confirmation Page
        if (goToOrderBtn) {
            goToOrderBtn.addEventListener('click', () => {
                const code = pairingInput.value.trim().toUpperCase();
                if (!code || code.replace(/[^A-Z0-9]/g, '').length < 6) {
                    showAlert(pairingAlert, 'يرجى فحص وإدخال كود الربط أولاً.', 'error');
                    pairingInput.focus();
                    return;
                }
                // Redirect to order page with parameters
                window.location.href = `order.html?code=${encodeURIComponent(code)}&plan=${encodeURIComponent(selectedPlan)}`;
            });
        }
    }

    // ──────────────── 3. Logic for Order Page (order.html) ────────────────
    const orderForm = document.getElementById('order-form');
    const orderDeviceSummary = document.getElementById('order-device-summary');
    const orderPlanSummary = document.getElementById('order-plan-summary');
    const unpairedWarning = document.getElementById('unpaired-warning');
    const orderContextBox = document.getElementById('order-context-box');

    const submitBtn = document.getElementById('submit-order-btn');
    const submitAlert = document.getElementById('submit-alert');
    const statusSection = document.getElementById('status-tracker-section');
    const trackerStatusBox = document.getElementById('tracker-status-box');
    const trackerIcon = document.getElementById('tracker-icon');
    const trackerTitle = document.getElementById('tracker-status-title');
    const trackerDesc = document.getElementById('tracker-status-desc');
    const trackReqId = document.getElementById('track-request-id');
    const trackPlan = document.getElementById('track-plan-name');
    const trackDevice = document.getElementById('track-device-id');
    const trackCode = document.getElementById('track-pairing-code');
    const refreshStatusBtn = document.getElementById('refresh-status-btn');

    const lookupInput = document.getElementById('lookup-input');
    const lookupBtn = document.getElementById('lookup-btn');
    const lookupAlert = document.getElementById('lookup-alert');

    if (orderForm) {
        const submitSpinner = submitBtn ? submitBtn.querySelector('.btn-spinner') : null;
        const submitText = submitBtn ? submitBtn.querySelector('.btn-text') : null;

        // Extract pairing code from URL or sessionStorage
        const activeCode = (urlParams.get('code') || sessionStorage.getItem('jeep_pairing_code') || '').toUpperCase();
        const planParam = urlParams.get('plan') || sessionStorage.getItem('jeep_selected_plan') || '6months';

        if (planMap[planParam]) {
            selectedPlan = planParam;
            selectedPlanTitle = planMap[planParam].title;
            selectedPlanPrice = planMap[planParam].price;
        }

        if (summaryPlanText) summaryPlanText.textContent = selectedPlanTitle;
        if (summaryPriceText) summaryPriceText.textContent = selectedPlanPrice;

        // Check if device is paired
        if (activeCode && activeCode.length >= 8) {
            if (unpairedWarning) unpairedWarning.classList.add('hidden');
            if (orderContextBox) orderContextBox.classList.remove('hidden');

            const devModelName = currentDevice ? (currentDevice.hardwareModel || 'Android Device') : 'Android Device';
            if (orderDeviceSummary) {
                orderDeviceSummary.textContent = `${activeCode} (${devModelName})`;
            }
            if (orderPlanSummary) {
                orderPlanSummary.textContent = `${selectedPlanTitle} (${selectedPlanPrice})`;
            }
        } else {
            // Unpaired warning shown
            if (unpairedWarning) unpairedWarning.classList.remove('hidden');
            if (orderContextBox) orderContextBox.classList.add('hidden');
        }

        // Submission Event
        orderForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            hideAlert(submitAlert);

            const codeToSubmit = (activeCode || sessionStorage.getItem('jeep_pairing_code') || '').toUpperCase();
            if (!codeToSubmit) {
                showAlert(submitAlert, 'يرجى ربط التطبيق بكود الربط أولاً قبل تقديم الطلب.', 'error');
                if (unpairedWarning) unpairedWarning.classList.remove('hidden');
                return;
            }

            const name = document.getElementById('customer-name').value.trim();
            const phone = document.getElementById('customer-phone').value.trim();
            const notes = document.getElementById('customer-notes') ? document.getElementById('customer-notes').value.trim() : '';

            if (!name || !phone) {
                showAlert(submitAlert, 'يرجى ملء حقول الاسم ورقم الهاتف.', 'error');
                return;
            }

            setLoading(submitBtn, submitSpinner, submitText, true, 'جارٍ إرسال الطلب...');

            try {
                const res = await fetch('/api/web/submit-request', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        pairingCode: codeToSubmit,
                        requestedPlan: selectedPlan,
                        customerName: name,
                        customerPhone: phone,
                        notes: notes
                    })
                });

                const data = await res.json();
                setLoading(submitBtn, submitSpinner, submitText, false, '🚀 إرسال طلب الاشتراك الآن');

                if (!res.ok || !data.success) {
                    showAlert(submitAlert, data.message || 'فشل إرسال الطلب، يرجى المحاولة لاحقاً.', 'error');
                    return;
                }

                showAlert(submitAlert, '🎉 تم إرسال طلب الاشتراك بنجاح وهو الآن بانتظار اعتماد المالك!', 'success');
                activeRequestId = data.request.id;
                sessionStorage.setItem('jeep_last_request_id', activeRequestId);

                // Show live tracker
                showTracker(data.request);

                // Start auto-poll every 4 seconds
                startStatusPolling(activeRequestId);

                setTimeout(() => {
                    if (statusSection) {
                        statusSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    }
                }, 300);

            } catch (err) {
                setLoading(submitBtn, submitSpinner, submitText, false, '🚀 إرسال طلب الاشتراك الآن');
                showAlert(submitAlert, 'تعذر الاتصال بالخادم لإرسال الطلب.', 'error');
            }
        });

        // Live Tracker UI helpers
        function showTracker(req) {
            if (!statusSection) return;
            if (trackReqId) trackReqId.textContent = req.id;
            if (trackPlan) trackPlan.textContent = req.requestedPlanName || req.requestedPlan;
            if (trackDevice) trackDevice.textContent = req.deviceId || 'DEV-...';
            if (trackCode) trackCode.textContent = req.pairingCode;

            updateTrackerUI(req.status, req);
            statusSection.classList.remove('hidden');
        }

        function updateTrackerUI(status, req) {
            if (!trackerStatusBox) return;
            trackerStatusBox.className = 'tracker-status-box';

            if (status === 'PENDING') {
                if (trackerIcon) trackerIcon.textContent = '⏳';
                if (trackerTitle) trackerTitle.textContent = 'الطلب قيد المراجعة';
                if (trackerDesc) trackerDesc.textContent = 'طلبك الآن بانتظار موافقة مالك النظام ومطابقة عملية الدفع وإصدار الترخيص الرقمي.';
            } else if (status === 'APPROVED') {
                trackerStatusBox.classList.add('approved');
                if (trackerIcon) trackerIcon.textContent = '🎉';
                if (trackerTitle) trackerTitle.textContent = 'تم قبول وتفعيل الاشتراك بنجاح!';
                if (trackerDesc) {
                    trackerDesc.innerHTML = `تم منحك <strong>${req.grantedDays} يومًا</strong> (${req.grantedPlan || 'اشتراك رسمي'}). <br>افتح الآن تطبيق "جيب كارت" على هاتفك واضغط على زر <strong>"مزامنة الترخيص"</strong> ليبدأ العمل فوراً!`;
                }
                stopStatusPolling();
            } else if (status === 'REJECTED') {
                trackerStatusBox.classList.add('rejected');
                if (trackerIcon) trackerIcon.textContent = '❌';
                if (trackerTitle) trackerTitle.textContent = 'تم رفض الطلب';
                if (trackerDesc) {
                    trackerDesc.textContent = `سبب الرفض: ${req.rejectionReason || 'طلب مرفوض من الإدارة'}. يرجى مراجعة الدعم الفني عبر الرقم 735717710.`;
                }
                stopStatusPolling();
            }
        }

        async function checkCurrentStatus(requestId) {
            try {
                const res = await fetch(`/api/web/request-status/${encodeURIComponent(requestId)}`);
                const data = await res.json();
                if (res.ok && data.success && data.request) {
                    updateTrackerUI(data.request.status, data.request);
                }
            } catch (e) {
                console.error('Status check error:', e);
            }
        }

        function startStatusPolling(requestId) {
            stopStatusPolling();
            pollInterval = setInterval(() => {
                checkCurrentStatus(requestId);
            }, 4000);
        }

        function stopStatusPolling() {
            if (pollInterval) {
                clearInterval(pollInterval);
                pollInterval = null;
            }
        }

        if (refreshStatusBtn) {
            refreshStatusBtn.addEventListener('click', () => {
                if (activeRequestId) {
                    checkCurrentStatus(activeRequestId);
                }
            });
        }

        // Auto-load last active request if stored
        if (activeRequestId) {
            checkCurrentStatus(activeRequestId);
        }

        // Order Lookup by ID or Pairing Code
        if (lookupBtn && lookupInput) {
            lookupBtn.addEventListener('click', async () => {
                const query = lookupInput.value.trim();
                hideAlert(lookupAlert);

                if (!query) {
                    showAlert(lookupAlert, 'يرجى إدخال رقم الطلب أو كود الربط.', 'error');
                    return;
                }

                try {
                    const res = await fetch(`/api/web/request-lookup?q=${encodeURIComponent(query)}`);
                    const data = await res.json();

                    if (!res.ok || !data.success || !data.request) {
                        showAlert(lookupAlert, data.message || 'لم يتم العثور على أي طلب مطابق.', 'error');
                        return;
                    }

                    showAlert(lookupAlert, '✓ تم العثور على الطلب بنجاح!', 'success');
                    activeRequestId = data.request.id;
                    sessionStorage.setItem('jeep_last_request_id', activeRequestId);
                    showTracker(data.request);
                    startStatusPolling(activeRequestId);

                    setTimeout(() => {
                        if (statusSection) {
                            statusSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
                        }
                    }, 300);

                } catch (e) {
                    showAlert(lookupAlert, 'تعذر الاستعلام من الخادم، يرجى المحاولة لاحقاً.', 'error');
                }
            });

            lookupInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    lookupBtn.click();
                }
            });
        }
    }
});
