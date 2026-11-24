// =========================================================================
// 請填入你的正式 LINE LIFF ID、GAS 部署網址 (/exec 結尾) 與官方帳號加好友網址
// =========================================================================
const LIFF_ID = "2012687270-krKUpomw";
const GAS_API_URL = "https://script.google.com/macros/s/AKfycbyK9l3YGWPuKE9uGLM2TlxwQy0C1nQxQCii79esd2uYFvyt5imgzenyLKWiBaws_HAw/exec";
const OA_ADD_FRIEND_URL = "https://line.me/R/ti/p/@184ibjmd";

const ENABLE_MOCK_MODE = false;
let isMockMode = false;

let currentUser = null;
let appState = null;
let currentTab = 'expenses';
let pendingInviteChoiceData = null;
let selectedClaimGuest = null;
let pendingPrefillDraft = null;
let reopenRecurringManage = false;

// SWR 快取、請求序號與背景同步狀態
let apiRequestSeq = 0;
let lastRenderedStateJson = '';
let lastSyncAt = 0;
let activeSilentSyncCount = 0;

// 編輯帳務二段式防誤刪狀態
let deleteExpenseArmed = false;
let deleteExpenseArmTimer = null;

// 帳務明細即時搜尋與篩選狀態
let lastFilterLedgerId = '';
let expenseSearchKeyword = '';
let expensePayerFilter = 'ALL';

// 彈窗裝置返回鍵攔截狀態（單一歷史守衛，避免多層彈窗切換造成歷史堆疊）
let hasModalHistoryGuard = false;
let ignoreNextPopState = false;
let modalHistorySyncTimer = null;

function isRunningInLineClient() {
    return !isMockMode && typeof liff !== 'undefined' && liff.isInClient && liff.isInClient();
}

function getLiffIdTokenSafe() {
    if (isMockMode || typeof liff === 'undefined' || !liff.getIDToken) return '';
    try {
        return liff.getIDToken() || '';
    } catch (e) {
        return '';
    }
}

function getLiffAccessTokenSafe() {
    if (isMockMode || typeof liff === 'undefined' || !liff.getAccessToken) return '';
    try {
        return liff.getAccessToken() || '';
    } catch (e) {
        return '';
    }
}

function forceExternalRelogin() {
    if (isMockMode || typeof liff === 'undefined') return false;
    const lastRetry = Number(sessionStorage.getItem('liff_relogin_at') || 0);
    if (Date.now() - lastRetry < 30000) return false;
    sessionStorage.setItem('liff_relogin_at', String(Date.now()));

    if (!isRunningInLineClient() && liff.isLoggedIn && liff.isLoggedIn()) {
        liff.logout();
    }
    liff.login();
    return true;
}

function updateCsvExportButtonUi() {
    const btn = document.getElementById('btnExportCsv');
    if (!btn) return;
    if (isRunningInLineClient()) {
        btn.innerHTML = '<i class="fa-solid fa-arrow-up-right-from-square"></i> 外部開啟匯出';
        btn.title = 'LINE 內建視窗不支援下載檔案，點擊改由外部瀏覽器開啟後即可匯出 CSV';
    } else {
        btn.innerHTML = '<i class="fa-solid fa-file-csv"></i> 匯出 CSV';
        btn.title = '匯出 CSV 明細報表';
    }
}

function getLocalCacheKey(userId) {
    return 'shared_ledger_state_v1_' + userId;
}

function buildComparableStateJson(state) {
    if (!state) return '';
    try {
        return JSON.stringify(Object.assign({}, state, {
            toastMessage: '',
            pendingInviteChoice: null
        }));
    } catch (e) {
        return '';
    }
}

function saveLocalStateCache(userId, state) {
    if (!userId || !state) return;
    try {
        const cleanJson = buildComparableStateJson(state);
        if (cleanJson) {
            localStorage.setItem(getLocalCacheKey(userId), cleanJson);
        }
    } catch (e) { }
}

function loadLocalStateCache(userId) {
    if (!userId) return null;
    try {
        const raw = localStorage.getItem(getLocalCacheKey(userId));
        return raw ? JSON.parse(raw) : null;
    } catch (e) {
        return null;
    }
}

function showSyncPill(show) {
    const el = document.getElementById('syncPill');
    if (!el) return;
    el.classList.toggle('hidden', !show);
}

function getCombinedSearchParams() {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('liff.state')) {
        const stateStr = urlParams.get('liff.state');
        const cleanState = stateStr.indexOf('?') === 0 ? stateStr.slice(1) : stateStr;
        const stateParams = new URLSearchParams(cleanState);
        stateParams.forEach((val, key) => {
            if (!urlParams.has(key)) urlParams.set(key, val);
        });
    }
    return urlParams;
}

function extractInviteCodeFromUrl() {
    const params = getCombinedSearchParams();
    const code = params.get('invite');
    return code ? code.trim().toUpperCase() : '';
}

function extractPrefillFromUrl() {
    const params = getCombinedSearchParams();
    const item = params.get('prefill_item');
    const amt = params.get('prefill_amt');
    if (!item || !amt) return null;

    return {
        ledgerId: params.get('prefill_ledger') || '',
        itemName: item,
        amount: Number(amt),
        payerId: params.get('prefill_payer') || '',
        splitUsers: params.get('prefill_splits') ? params.get('prefill_splits').split(',').filter(Boolean) : []
    };
}

// =========================================================================
// 1. 初始化 LINE LIFF 與官方帳號好友狀態偵測
// =========================================================================
(async function initLiffApp() {
    try {
        const urlParams = new URLSearchParams(window.location.search);
        const mockUserId = urlParams.get('mock_user');
        const mockUserName = urlParams.get('mock_name') || '測試成員';
        const incomingInvite = extractInviteCodeFromUrl();
        const incomingPrefill = extractPrefillFromUrl();

        // 【分支 A：模擬測試模式（正式上線時已透過 ENABLE_MOCK_MODE = false 停用）】
        if (ENABLE_MOCK_MODE && mockUserId) {
            isMockMode = true;
            currentUser = {
                userId: mockUserId,
                displayName: mockUserName
            };
            if (incomingPrefill) {
                pendingPrefillDraft = incomingPrefill;
            }

            const banner = document.createElement('div');
            banner.style.cssText = 'background:#3d2c27; color:#fcecef; font-size:12px; text-align:center; padding:6px; font-weight:700;';
            banner.textContent = '🧪 模擬測試模式｜目前角色：' + mockUserName + ' (' + mockUserId + ')';
            document.body.insertBefore(banner, document.body.firstChild);

            if ((incomingInvite || incomingPrefill) && window.history && window.history.replaceState) {
                ['invite', 'prefill_ledger', 'prefill_item', 'prefill_amt', 'prefill_payer', 'prefill_splits'].forEach(k => urlParams.delete(k));
                const remainQuery = urlParams.toString();
                const cleanMockUrl = window.location.pathname + (remainQuery ? '?' + remainQuery : '');
                window.history.replaceState({}, document.title, cleanMockUrl);
            }

            document.getElementById('topControlBar').classList.remove('hidden');
            await callGasApi('bootstrap', {
                userProfile: currentUser,
                inviteCode: incomingInvite
            }, '正在載入模擬帳號資料...');
            return;
        }

        // 【分支 B：正式 LINE LIFF 模式】
        if (incomingInvite) {
            localStorage.setItem('pending_invite_code', incomingInvite);
        }
        if (incomingPrefill) {
            localStorage.setItem('pending_prefill_draft', JSON.stringify(incomingPrefill));
        }

        await liff.init({ liffId: LIFF_ID });

        const postInitInvite = extractInviteCodeFromUrl();
        if (postInitInvite) {
            localStorage.setItem('pending_invite_code', postInitInvite);
        }
        const postInitPrefill = extractPrefillFromUrl();
        if (postInitPrefill) {
            localStorage.setItem('pending_prefill_draft', JSON.stringify(postInitPrefill));
        }

        if (!liff.isLoggedIn()) {
            liff.login();
            return;
        }

        let profile;
        try {
            profile = await liff.getProfile();
        } catch (profileErr) {
            if (forceExternalRelogin()) return;
            throw profileErr;
        }
        currentUser = {
            userId: profile.userId,
            displayName: profile.displayName
        };

        checkOfficialAccountFriendship();
        updateCsvExportButtonUi();

        const finalInviteCode = localStorage.getItem('pending_invite_code') || '';
        if (finalInviteCode) {
            localStorage.removeItem('pending_invite_code');
        }

        const savedPrefillRaw = localStorage.getItem('pending_prefill_draft');
        if (savedPrefillRaw) {
            localStorage.removeItem('pending_prefill_draft');
            try {
                pendingPrefillDraft = JSON.parse(savedPrefillRaw);
            } catch (e) { }
        }

        if (window.history && window.history.replaceState) {
            window.history.replaceState({}, document.title, window.location.pathname);
        }

        document.getElementById('topControlBar').classList.remove('hidden');

        // SWR 秒開策略：無邀請碼與預填草稿時，先渲染本地快取畫面，再於背景靜默同步最新帳務
        const cachedState = (!finalInviteCode && !pendingPrefillDraft)
            ? loadLocalStateCache(currentUser.userId)
            : null;

        if (cachedState) {
            hideLoading();
            lastRenderedStateJson = buildComparableStateJson(cachedState);
            renderAppState(cachedState);
            callGasApi('bootstrap', {
                userProfile: currentUser,
                inviteCode: ''
            }, '', { silent: true });
        } else {
            await callGasApi('bootstrap', {
                userProfile: currentUser,
                inviteCode: finalInviteCode
            }, '正在載入帳本資料...');
        }
    } catch (err) {
        document.getElementById('loadingText').innerHTML =
            '<div style="padding:0 24px; text-align:center; color:#d64545; line-height:1.6;">' +
            '初始化失敗：' + escapeHtml(err.message || String(err)) +
            '</div>';
    }
})();

async function checkOfficialAccountFriendship() {
    if (isMockMode || typeof liff === 'undefined' || !liff.isLoggedIn || !liff.isLoggedIn()) return;
    try {
        const friendship = await liff.getFriendship();
        const bannerEl = document.getElementById('addFriendBanner');
        if (friendship && friendship.friendFlag === false) {
            bannerEl.classList.remove('hidden');
        } else {
            bannerEl.classList.add('hidden');
        }
    } catch (err) {
        console.warn('無法取得官方帳號好友狀態:', err.message);
    }
}

function openAddOfficialAccount() {
    if (isRunningInLineClient()) {
        liff.openWindow({ url: OA_ADD_FRIEND_URL, external: false });
    } else {
        window.open(OA_ADD_FRIEND_URL, '_blank');
    }
}

function manualRefreshApp() {
    if (!currentUser || activeSilentSyncCount > 0) return;
    callGasApi('bootstrap', {
        userProfile: currentUser,
        inviteCode: ''
    }, '', { silent: true, manualRefresh: true });
}

document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && currentUser) {
        checkOfficialAccountFriendship();
        // 切回前景且距離上次同步超過 15 秒時，背景靜默同步最新帳務
        if (activeSilentSyncCount === 0 && (Date.now() - lastSyncAt > 15000)) {
            callGasApi('bootstrap', {
                userProfile: currentUser,
                inviteCode: ''
            }, '', { silent: true });
        }
    }
});

// =========================================================================
// 2. 透過 fetch 呼叫 GAS 純 JSON API（附帶 ID Token、靜默同步與快取防覆蓋）
// =========================================================================
async function callGasApi(action, payloadObj, loadingMsg, options) {
    const isSilent = Boolean(options && options.silent);
    const isManualRefresh = Boolean(options && options.manualRefresh);
    const reqSeq = ++apiRequestSeq;
    const refreshBtn = document.getElementById('btnManualRefresh');

    if (isSilent) {
        activeSilentSyncCount++;
        showSyncPill(true);
        if (isManualRefresh && refreshBtn) refreshBtn.classList.add('syncing');
    } else {
        showSyncPill(false);
        showLoading(loadingMsg || '處理中...');
    }

    try {
        const bodyObj = Object.assign({
            api_action: action,
            idToken: getLiffIdTokenSafe(),
            accessToken: getLiffAccessTokenSafe()
        }, payloadObj);

        const response = await fetch(GAS_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'text/plain;charset=utf-8'
            },
            body: JSON.stringify(bodyObj)
        });

        if (!response.ok) {
            throw new Error('伺服器連線異常 (HTTP ' + response.status + ')');
        }

        const json = await response.json();
        if (!json.ok) {
            if (json.error === 'AUTH_EXPIRED' && !isMockMode && typeof liff !== 'undefined') {
                if (!isSilent) hideLoading();
                showToast('LINE 登入憑證已過期，正在重新驗證...', 3000);
                setTimeout(function () {
                    if (!forceExternalRelogin()) {
                        showToast('登入狀態異常，請清除瀏覽器網站資料後重開', 4500);
                    }
                }, 600);
                return;
            }
            throw new Error(json.error || '操作失敗');
        }

        // 若背景同步期間已有更新的主動請求發出，略過過時回應避免覆蓋最新狀態
        if (isSilent && reqSeq !== apiRequestSeq) {
            return;
        }

        lastSyncAt = Date.now();
        const nextState = json.data;
        const nextComparableJson = buildComparableStateJson(nextState);

        if (currentUser && currentUser.userId) {
            saveLocalStateCache(currentUser.userId, nextState);
        }

        if (isSilent) {
            // 若資料毫無變動且沒有需要顯示的提示或認領彈窗，跳過重複重繪避免畫面閃動
            if (nextComparableJson && nextComparableJson === lastRenderedStateJson &&
                !nextState.toastMessage && !nextState.pendingInviteChoice) {
                appState = nextState;
                if (isManualRefresh) showToast('目前已是最新帳務資料', 2200);
                return;
            }
            if (isManualRefresh && !nextState.toastMessage) {
                showToast('已同步最新帳務資料', 2200);
            }
        } else {
            hideLoading();
        }

        lastRenderedStateJson = nextComparableJson;
        renderAppState(nextState);
        if (reopenRecurringManage) {
            reopenRecurringManage = false;
            openRecurringManageModal();
        }
    } catch (err) {
        if (isSilent) {
            if (reqSeq === apiRequestSeq) {
                showToast(isManualRefresh ? (err.message || '同步失敗，請稍後再試') : '背景同步失敗，目前顯示為上次快取資料', 3500);
            }
        } else {
            hideLoading();
            showToast(err.message || '網路連線發生錯誤，請稍後再試', 4500);
        }
    } finally {
        if (isSilent) {
            activeSilentSyncCount = Math.max(0, activeSilentSyncCount - 1);
            if (activeSilentSyncCount === 0) {
                showSyncPill(false);
                if (refreshBtn) refreshBtn.classList.remove('syncing');
            }
        }
    }
}

// =========================================================================
// 3. 主畫面資料渲染
// =========================================================================
function renderAppState(state) {
    appState = state;
    if (state.toastMessage) {
        showToast(state.toastMessage);
    }

    if (state.pendingInviteChoice) {
        openClaimStep1Modal(state.pendingInviteChoice);
    }

    const selectEl = document.getElementById('ledgerSelect');
    selectEl.innerHTML = '';
    if (!state.ledgers || state.ledgers.length === 0) {
        selectEl.innerHTML = '<option value="">尚未加入任何帳本</option>';
        document.getElementById('emptyStateView').classList.remove('hidden');
        document.getElementById('mainDashboardView').classList.add('hidden');
        document.getElementById('fabAddExpense').classList.add('hidden');
        return;
    }

    state.ledgers.forEach(function (l) {
        const opt = document.createElement('option');
        opt.value = l.ledger_id;
        const prefix = l.status === 'SETTLED' ? '🔒 ' : (l.isCreator ? '👑 ' : '');
        opt.textContent = prefix + l.title;
        if (l.ledger_id === state.activeLedgerId) opt.selected = true;
        selectEl.appendChild(opt);
    });

    const data = state.activeLedgerData;
    if (!data) return;

    document.getElementById('emptyStateView').classList.add('hidden');
    document.getElementById('mainDashboardView').classList.remove('hidden');

    const ledger = data.ledger;
    const perm = data.permissions;
    const personal = data.personal;

    const titleEl = document.getElementById('ledgerTitle');
    if (perm.canRenameLedger) {
        titleEl.innerHTML = escapeHtml(ledger.title) +
            '<button type="button" class="edit-link" style="margin-top:0; margin-left:8px; padding:2px 8px; vertical-align:middle;" onclick="openRenameLedgerModal()" title="編輯帳本名稱">' +
            '<i class="fa-solid fa-pen"></i></button>';
    } else {
        titleEl.textContent = ledger.title;
    }

    document.getElementById('ledgerMeta').innerHTML =
        '成員 ' + data.members.length + ' 人・我的暱稱：<b>' + escapeHtml(personal.nickname) + '</b>' +
        '<button type="button" class="edit-link" style="margin-top:0; margin-left:6px; padding:2px 7px;" onclick="openNicknameModal(\'' + currentUser.userId + '\')">' +
        '<i class="fa-solid fa-pen"></i> 改名</button>';

    const badge = document.getElementById('ledgerStatusBadge');
    if (perm.isSettled) {
        badge.className = 'status-badge status-settled';
        badge.innerHTML = '<i class="fa-solid fa-lock"></i> 已結算鎖定';
    } else {
        badge.className = 'status-badge status-active';
        badge.innerHTML = '<i class="fa-solid fa-circle-play"></i> 進行中';
    }

    document.getElementById('ledgerTotalAmount').textContent = formatMoney(ledger.totalAmount);

    const heroSubEl = document.getElementById('heroSubsidySub');
    if (ledger.hasSubsidy) {
        heroSubEl.textContent = '含贊助／補助折抵 -$' + ledger.totalSubsidy.toLocaleString();
        heroSubEl.classList.remove('hidden');
    } else {
        heroSubEl.classList.add('hidden');
    }

    const heroNetEl = document.getElementById('heroMyNet');
    heroNetEl.textContent = formatNetMoney(personal.netBalance);
    heroNetEl.className = personal.netBalance > 0 ? 'text-green' : (personal.netBalance < 0 ? 'text-red' : '');

    const inviteBar = document.getElementById('creatorInviteBar');
    if (perm.canInvite) {
        inviteBar.classList.remove('hidden');
        document.getElementById('inviteCodeText').textContent = ledger.invite_code;
    } else {
        inviteBar.classList.add('hidden');
    }

    const addGuestBtn = document.getElementById('btnAddGuest');
    if (perm.canAddGuest) {
        addGuestBtn.classList.remove('hidden');
    } else {
        addGuestBtn.classList.add('hidden');
    }

    if (perm.canEdit) {
        document.getElementById('fabAddExpense').classList.remove('hidden');
        document.getElementById('readOnlyHint').classList.add('hidden');
    } else {
        document.getElementById('fabAddExpense').classList.add('hidden');
        document.getElementById('readOnlyHint').classList.remove('hidden');
    }

    if (perm.canSettle) {
        document.getElementById('creatorSettleCard').classList.remove('hidden');
    } else {
        document.getElementById('creatorSettleCard').classList.add('hidden');
    }

    if (perm.canTransferAdmin) {
        document.getElementById('creatorTransferAdminCard').classList.remove('hidden');
    } else {
        document.getElementById('creatorTransferAdminCard').classList.add('hidden');
    }

    if (perm.canDeleteLedger) {
        document.getElementById('creatorDeleteLedgerCard').classList.remove('hidden');
    } else {
        document.getElementById('creatorDeleteLedgerCard').classList.add('hidden');
    }

    renderExpensesTab(data);
    renderPersonalTab(data);
    renderSettlementTab(data);

    // 渲染分頁 1 頂部的「定期支出待入帳提醒條」
    const pendingList = getEnrichedRecurringTemplates().filter(function (t) { return !t.isLoggedInActive; });
    const alertBar = document.getElementById('pendingRecurringBanner');
    if (perm.canEdit && pendingList.length > 0) {
        const previewNames = pendingList.slice(0, 2).map(function (t) { return t.item_name; }).join('、');
        const moreSuffix = pendingList.length > 2 ? ' 等 ' + pendingList.length + ' 筆' : '（共 ' + pendingList.length + ' 筆）';
        document.getElementById('pendingRecurringText').innerHTML =
            '定期支出待入帳：<b>' + escapeHtml(previewNames) + '</b>' + moreSuffix;
        alertBar.classList.remove('hidden');
    } else {
        alertBar.classList.add('hidden');
    }

    if (pendingPrefillDraft) {
        const draftToApply = pendingPrefillDraft;
        if (draftToApply.ledgerId && draftToApply.ledgerId !== state.activeLedgerId) {
            const existsInUserLedgers = state.ledgers.some(l => l.ledger_id === draftToApply.ledgerId);
            if (existsInUserLedgers) {
                callGasApi('switchLedger', { userId: currentUser.userId, ledgerId: draftToApply.ledgerId }, '正在切換至草稿目標帳本...');
                return;
            }
        }

        pendingPrefillDraft = null;
        if (perm.canEdit) {
            openExpenseModal(null, draftToApply);
            showToast('已帶入聊天室草稿，請確認均攤成員後儲存');
        } else {
            showToast('此帳本已結算鎖定，無法新增帳務');
        }
    }
}

function renderExpensesTab(data) {
    const ledgerId = data && data.ledger ? data.ledger.ledger_id : '';
    const list = data.expenses || [];
    const filterBar = document.getElementById('expenseFilterBar');
    const searchInput = document.getElementById('expenseSearchInput');
    const payerSelect = document.getElementById('expensePayerFilter');

    // 切換帳本時重置搜尋與篩選條件
    if (ledgerId !== lastFilterLedgerId) {
        lastFilterLedgerId = ledgerId;
        expenseSearchKeyword = '';
        expensePayerFilter = 'ALL';
        if (searchInput) searchInput.value = '';
    }

    if (filterBar && payerSelect) {
        if (list.length > 0) {
            filterBar.classList.remove('hidden');
            let optionsHtml = '<option value="ALL">全部對象</option>';
            if (data.ledger && data.ledger.hasSubsidy) {
                optionsHtml += '<option value="TYPE_SUBSIDY">🎁 僅贊助／補助</option>';
            }
            (data.members || []).forEach(function (m) {
                const suffix = m.userId === currentUser.userId ? ' (我)' : '';
                optionsHtml += '<option value="' + m.userId + '">' + escapeHtml(m.nickname) + suffix + '</option>';
            });
            payerSelect.innerHTML = optionsHtml;

            const validValues = new Set(Array.from(payerSelect.options).map(function (o) { return o.value; }));
            if (!validValues.has(expensePayerFilter)) {
                expensePayerFilter = 'ALL';
            }
            payerSelect.value = expensePayerFilter;
        } else {
            filterBar.classList.add('hidden');
        }
    }

    renderFilteredExpensesList();
}

function onExpenseFilterChange() {
    const searchEl = document.getElementById('expenseSearchInput');
    const payerEl = document.getElementById('expensePayerFilter');
    expenseSearchKeyword = searchEl ? searchEl.value.trim().toLowerCase() : '';
    expensePayerFilter = payerEl ? payerEl.value : 'ALL';
    renderFilteredExpensesList();
}

function clearExpenseFilters() {
    expenseSearchKeyword = '';
    expensePayerFilter = 'ALL';
    const searchEl = document.getElementById('expenseSearchInput');
    const payerEl = document.getElementById('expensePayerFilter');
    if (searchEl) searchEl.value = '';
    if (payerEl) payerEl.value = 'ALL';
    renderFilteredExpensesList();
}

function renderFilteredExpensesList() {
    const data = appState && appState.activeLedgerData;
    if (!data) return;

    const allList = data.expenses || [];
    const container = document.getElementById('expenseListContainer');
    const isFiltering = Boolean(expenseSearchKeyword || expensePayerFilter !== 'ALL');

    const filtered = allList.filter(function (exp) {
        if (expensePayerFilter === 'TYPE_SUBSIDY') {
            if (exp.record_type !== 'SUBSIDY') return false;
        } else if (expensePayerFilter !== 'ALL') {
            if (exp.payer_id !== expensePayerFilter) return false;
        }

        if (expenseSearchKeyword) {
            const haystack = (
                String(exp.item_name || '') + ' ' +
                String(exp.payerName || '') + ' ' +
                (exp.splitNames || []).join(' ')
            ).toLowerCase();
            if (haystack.indexOf(expenseSearchKeyword) === -1) return false;
        }
        return true;
    });

    document.getElementById('expenseCount').textContent = isFiltering
        ? (filtered.length + ' / ' + allList.length)
        : String(allList.length);

    if (allList.length === 0) {
        container.innerHTML = '<div style="text-align:center; padding:24px 0; color:var(--text-sub); font-size:13px;">' +
            '目前還沒有任何帳務紀錄，點擊下方「新增帳務項目」開始吧！</div>';
        return;
    }

    if (filtered.length === 0) {
        container.innerHTML = '<div style="text-align:center; padding:22px 0; color:var(--text-sub); font-size:13px;">' +
            '找不到符合篩選條件的帳務項目<br>' +
            '<button type="button" class="edit-link" style="margin-top:8px;" onclick="clearExpenseFilters()">清除篩選條件</button>' +
            '</div>';
        return;
    }

    container.innerHTML = filtered.map(function (exp) {
        const isSubsidy = exp.record_type === 'SUBSIDY';
        const perShare = exp.split_users.length > 0
            ? Math.round((exp.amount / exp.split_users.length) * 10) / 10
            : 0;
        const editBtnHtml = data.permissions.canEdit
            ? '<button class="edit-link" onclick="openExpenseModal(\'' + exp.expense_id + '\')"><i class="fa-solid fa-pen"></i> 編輯</button>'
            : '';

        if (isSubsidy) {
            return '<div class="expense-item is-subsidy">' +
                '<div class="expense-main">' +
                '<div class="expense-title"><i class="fa-solid fa-gift" style="color:var(--green); margin-right:4px;"></i>' + escapeHtml(exp.item_name) + '</div>' +
                '<div class="expense-sub">' +
                '<span class="subsidy-tag">' + escapeHtml(exp.payerName) + ' 贊助／補助</span>' +
                '受惠 (' + exp.splitNames.length + '人)：' + escapeHtml(exp.splitNames.join('、')) +
                '<br><span style="font-size:11px; opacity:0.85;">每人折抵 $' + perShare.toLocaleString() + '・' + escapeHtml(exp.created_at) + '</span>' +
                '</div></div>' +
                '<div class="expense-right">' +
                '<div class="expense-amount text-green">折抵 -' + formatMoney(exp.amount) + '</div>' +
                editBtnHtml +
                '</div></div>';
        }

        return '<div class="expense-item">' +
            '<div class="expense-main">' +
            '<div class="expense-title">' + escapeHtml(exp.item_name) + '</div>' +
            '<div class="expense-sub">' +
            '<span class="payer-tag">' + escapeHtml(exp.payerName) + ' 預付</span>' +
            '均攤 (' + exp.splitNames.length + '人)：' + escapeHtml(exp.splitNames.join('、')) +
            '<br><span style="font-size:11px; opacity:0.85;">每人約 $' + perShare.toLocaleString() + '・' + escapeHtml(exp.created_at) + '</span>' +
            '</div></div>' +
            '<div class="expense-right">' +
            '<div class="expense-amount">' + formatMoney(exp.amount) + '</div>' +
            editBtnHtml +
            '</div></div>';
    }).join('');
}

function renderPersonalTab(data) {
    const p = data.personal;
    const hasSubsidy = Boolean(data.ledger && data.ledger.hasSubsidy);
    document.getElementById('myTotalPaid').textContent = formatMoney(p.totalPaid);
    document.getElementById('myTotalShare').textContent = formatMoney(p.totalShare);

    const personalGrid = document.getElementById('personalGrid');
    const subsidyStatBox = document.getElementById('mySubsidyStatBox');
    const subsidyNetEl = document.getElementById('mySubsidyNet');
    if (hasSubsidy || p.subsidyNet !== 0) {
        personalGrid.classList.add('has-subsidy');
        subsidyStatBox.classList.remove('hidden');
        subsidyNetEl.textContent = formatSignedMoney(p.subsidyNet || 0);
        subsidyNetEl.className = p.subsidyNet > 0 ? 'text-green' : (p.subsidyNet < 0 ? 'text-red' : '');
    } else {
        personalGrid.classList.remove('has-subsidy');
        subsidyStatBox.classList.add('hidden');
    }

    const netEl = document.getElementById('myNetBalance');
    netEl.textContent = formatNetMoney(p.netBalance);
    netEl.className = p.netBalance > 0 ? 'text-green' : (p.netBalance < 0 ? 'text-red' : '');

    const myTransSec = document.getElementById('myTransferSection');
    const myTransList = document.getElementById('myTransferList');
    if (p.myTransfers && p.myTransfers.length > 0) {
        myTransSec.classList.remove('hidden');
        myTransList.innerHTML = p.myTransfers.map(function (t) {
            const isMePayer = t.fromId === currentUser.userId;
            return '<div class="transfer-row">' +
                '<div class="transfer-users">' +
                '<span>' + (isMePayer ? '我' : escapeHtml(t.fromName)) + '</span>' +
                '<i class="fa-solid fa-arrow-right transfer-arrow"></i>' +
                '<span>' + (!isMePayer ? '我' : escapeHtml(t.toName)) + '</span>' +
                '</div>' +
                '<div class="transfer-amt ' + (isMePayer ? 'text-red' : 'text-green') + '">' +
                (isMePayer ? '應付' : '應收') + ' ' + formatMoney(t.amount) +
                '</div></div>';
        }).join('');
    } else {
        myTransSec.classList.add('hidden');
    }

    document.getElementById('myPaidCount').textContent = p.paidItems.length;
    const paidContainer = document.getElementById('myPaidList');
    paidContainer.innerHTML = p.paidItems.length === 0
        ? '<div style="font-size:13px; color:var(--text-sub); text-align:center; padding:12px 0;">尚無預先支付項目</div>'
        : p.paidItems.map(function (item) {
            return '<div class="expense-item">' +
                '<div class="expense-main">' +
                '<div class="expense-title">' + escapeHtml(item.item_name) + '</div>' +
                '<div class="expense-sub">分攤對象 (' + item.splitCount + '人)：' + escapeHtml(item.splitNames.join('、')) + '</div>' +
                '</div>' +
                '<div class="expense-right">' +
                '<div class="expense-amount text-green">+' + formatMoney(item.amount) + '</div>' +
                '</div></div>';
        }).join('');

    document.getElementById('mySplitCount').textContent = p.splitItems.length;
    const splitContainer = document.getElementById('mySplitList');
    splitContainer.innerHTML = p.splitItems.length === 0
        ? '<div style="font-size:13px; color:var(--text-sub); text-align:center; padding:12px 0;">尚無參與均攤項目</div>'
        : p.splitItems.map(function (item) {
            return '<div class="expense-item">' +
                '<div class="expense-main">' +
                '<div class="expense-title">' + escapeHtml(item.item_name) + '</div>' +
                '<div class="expense-sub">' + escapeHtml(item.payerName) + ' 預付總額 $' + item.totalAmount.toLocaleString() + '（共 ' + item.splitCount + ' 人均攤）</div>' +
                '</div>' +
                '<div class="expense-right">' +
                '<div class="expense-amount text-red">-$' + item.myShare.toLocaleString() + '</div>' +
                '</div></div>';
        }).join('');

    // 條件式顯示「我參與的贊助／補助款」區塊
    const subsidyItems = p.subsidyItems || [];
    const subsidyCard = document.getElementById('mySubsidyCard');
    if (subsidyItems.length > 0) {
        subsidyCard.classList.remove('hidden');
        document.getElementById('mySubsidyCount').textContent = subsidyItems.length;
        document.getElementById('mySubsidyList').innerHTML = subsidyItems.map(function (item) {
            let desc = '';
            if (item.isProvider && item.isBeneficiary) {
                desc = '我提供 $' + item.totalAmount.toLocaleString() + '・與 ' + escapeHtml(item.splitNames.join('、')) + ' 平分（每人折抵 $' + item.perBenefit.toLocaleString() + '）';
            } else if (item.isProvider) {
                desc = '我提供 $' + item.totalAmount.toLocaleString() + ' 贊助給 ' + escapeHtml(item.splitNames.join('、')) + '（每人折抵 $' + item.perBenefit.toLocaleString() + '）';
            } else {
                desc = escapeHtml(item.providerName) + ' 提供 $' + item.totalAmount.toLocaleString() + '（共 ' + item.splitCount + ' 人受惠，我折抵 $' + item.perBenefit.toLocaleString() + '）';
            }

            const amtClass = item.myImpact > 0 ? 'text-green' : (item.myImpact < 0 ? 'text-red' : '');
            const amtSign = item.myImpact > 0 ? '+' : (item.myImpact < 0 ? '-' : '');
            return '<div class="expense-item">' +
                '<div class="expense-main">' +
                '<div class="expense-title">' + escapeHtml(item.item_name) + '</div>' +
                '<div class="expense-sub">' + desc + '</div>' +
                '</div>' +
                '<div class="expense-right">' +
                '<div class="expense-amount ' + amtClass + '">' + amtSign + '$' + Math.abs(item.myImpact).toLocaleString() + '</div>' +
                '</div></div>';
        }).join('');
    } else {
        subsidyCard.classList.add('hidden');
    }
}

function renderSettlementTab(data) {
    updateCsvExportButtonUi();
    const transfers = data.transfers || [];
    const transContainer = document.getElementById('allTransferList');

    if (transfers.length === 0) {
        transContainer.innerHTML = '<div style="text-align:center; padding:14px 0; color:var(--green); font-size:13px; font-weight:700;">' +
            '<i class="fa-solid fa-circle-check"></i> 目前所有成員帳目已平衡，無需轉帳！</div>';
    } else {
        transContainer.innerHTML = transfers.map(function (t) {
            return '<div class="transfer-row">' +
                '<div class="transfer-users">' +
                '<span>' + escapeHtml(t.fromName) + '</span>' +
                '<i class="fa-solid fa-arrow-right transfer-arrow"></i>' +
                '<span>' + escapeHtml(t.toName) + '</span>' +
                '</div>' +
                '<div class="transfer-amt">' + formatMoney(t.amount) + '</div>' +
                '</div>';
        }).join('');
    }

    const hasSubsidy = Boolean(data.ledger && data.ledger.hasSubsidy);
    const thSubsidy = document.getElementById('thSubsidyCol');
    if (hasSubsidy) thSubsidy.classList.remove('hidden');
    else thSubsidy.classList.add('hidden');

    const isAdmin = data.permissions.isCreator;
    const tbody = document.getElementById('memberSummaryBody');
    tbody.innerHTML = (data.memberSummaries || []).map(function (m, idx) {
        const netClass = m.netBalance > 0 ? 'text-green' : (m.netBalance < 0 ? 'text-red' : '');
        const subVal = m.subsidyNet || 0;
        const subClass = subVal > 0 ? 'text-green' : (subVal < 0 ? 'text-red' : '');
        const isMe = m.userId === currentUser.userId;
        const meLabel = isMe ? ' <span style="color:var(--text-sub); font-weight:normal;">(我)</span>' : '';
        const adminTag = m.userId === data.ledger.creator_id ? '<span class="admin-badge">管理者</span>' : '';
        const guestTag = m.isGuest ? '<span class="guest-badge">未綁定</span>' : '';
        const numBadge = '<span style="color:var(--text-sub); font-size:12px; font-weight:700;">' + (idx + 1) + '. </span>';

        const renameBtn = (isAdmin || isMe)
            ? '<button type="button" class="mini-icon-btn" onclick="openNicknameModal(\'' + m.userId + '\')" title="修改暱稱"><i class="fa-solid fa-pen"></i></button>'
            : '';

        const removeBtn = (isAdmin && m.userId !== data.ledger.creator_id)
            ? '<button type="button" class="mini-icon-btn danger" onclick="openRemoveMemberModal(\'' + m.userId + '\')" title="移除成員"><i class="fa-solid fa-trash"></i></button>'
            : '';

        const subsidyTd = hasSubsidy
            ? '<td class="num-col ' + subClass + '" style="font-weight:700;">' + formatSignedMoney(subVal) + '</td>'
            : '';

        return '<tr>' +
            '<td style="font-weight:700;">' + numBadge + escapeHtml(m.nickname) + meLabel + adminTag + guestTag + renameBtn + removeBtn + '</td>' +
            '<td class="num-col">' + formatMoney(m.totalPaid) + '</td>' +
            '<td class="num-col">' + formatMoney(m.totalShare) + '</td>' +
            subsidyTd +
            '<td class="num-col ' + netClass + '" style="font-weight:800;">' + formatNetMoney(m.netBalance) + '</td>' +
            '</tr>';
    }).join('');
}

// =========================================================================
// 4. 互動操作
// =========================================================================
function switchTab(tabName) {
    currentTab = tabName;
    document.querySelectorAll('.tab-btn').forEach(function (btn) {
        btn.classList.toggle('active', btn.dataset.tab === tabName);
    });
    document.querySelectorAll('.tab-panel').forEach(function (panel) {
        panel.classList.add('hidden');
    });
    document.getElementById('tab-' + tabName).classList.remove('hidden');
}

function onSwitchLedger(ledgerId) {
    if (!ledgerId || ledgerId === appState.activeLedgerId) return;
    callGasApi('switchLedger', { userId: currentUser.userId, ledgerId: ledgerId }, '正在切換帳本...');
}

// --- 操作手冊與 FAQ 彈窗控制與關鍵字過濾 ---
function openFaqModal() {
    const searchInput = document.getElementById('faqSearchInput');
    searchInput.value = '';
    filterFaqItems();
    openModal('faqModal');
}

function filterFaqItems() {
    const keyword = document.getElementById('faqSearchInput').value.trim().toLowerCase();
    const groups = document.querySelectorAll('.faq-category-group');
    let totalVisible = 0;

    groups.forEach(function (group) {
        const items = group.querySelectorAll('.faq-item');
        let groupVisible = 0;

        items.forEach(function (item) {
            const text = item.textContent.toLowerCase();
            if (!keyword || text.indexOf(keyword) !== -1) {
                item.classList.remove('hidden');
                if (keyword) item.setAttribute('open', '');
                else item.removeAttribute('open');
                groupVisible++;
                totalVisible++;
            } else {
                item.classList.add('hidden');
                item.removeAttribute('open');
            }
        });

        if (groupVisible > 0) {
            group.classList.remove('hidden');
        } else {
            group.classList.add('hidden');
        }
    });

    const emptyNotice = document.getElementById('faqEmptyNotice');
    if (totalVisible === 0) {
        emptyNotice.classList.remove('hidden');
    } else {
        emptyNotice.classList.add('hidden');
    }
}

// --- 建立新帳本（含沿用目前預設帳本成員） ---
function openCreateLedgerModal() {
    document.getElementById('newLedgerTitle').value = '';
    const copySection = document.getElementById('copyMembersSection');
    const copyCheckbox = document.getElementById('copyMembersCheckbox');
    const listWrap = document.getElementById('copyMembersListWrap');
    const grid = document.getElementById('copyMembersGrid');

    const data = appState && appState.activeLedgerData;
    const otherMembers = data && data.members
        ? data.members.filter(function (m) { return m.userId !== currentUser.userId; })
        : [];

    if (data && otherMembers.length > 0) {
        copySection.classList.remove('hidden');
        document.getElementById('copySourceLedgerName').textContent = data.ledger.title;
        copyCheckbox.checked = false;
        listWrap.classList.add('hidden');

        grid.innerHTML = otherMembers.map(function (m) {
            const guestBadge = m.isGuest ? '<span class="guest-badge">未綁定</span>' : '';
            return '<label class="split-chip checked" onclick="onToggleCopyMemberChip(this)">' +
                '<input type="checkbox" name="copyMemberUser" value="' + m.userId + '" checked />' +
                '<span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + escapeHtml(m.nickname) + '</span>' +
                guestBadge +
                '</label>';
        }).join('');
    } else {
        copySection.classList.add('hidden');
        copyCheckbox.checked = false;
        listWrap.classList.add('hidden');
        grid.innerHTML = '';
    }

    openModal('createLedgerModal');
}

function onToggleCopyMembers() {
    const isChecked = document.getElementById('copyMembersCheckbox').checked;
    const listWrap = document.getElementById('copyMembersListWrap');
    if (isChecked) {
        listWrap.classList.remove('hidden');
    } else {
        listWrap.classList.add('hidden');
    }
}

function onToggleCopyMemberChip(labelEl) {
    setTimeout(function () {
        const cb = labelEl.querySelector('input[type="checkbox"]');
        labelEl.classList.toggle('checked', cb.checked);
    }, 0);
}

function submitCreateLedger() {
    const title = document.getElementById('newLedgerTitle').value.trim();
    if (!title) {
        showToast('請輸入帳本名稱');
        return;
    }

    const shouldCopy = document.getElementById('copyMembersCheckbox').checked;
    let copyFromLedgerId = '';
    let copyMemberIds = [];

    if (shouldCopy && appState && appState.activeLedgerId) {
        copyFromLedgerId = appState.activeLedgerId;
        copyMemberIds = Array.from(document.querySelectorAll('input[name="copyMemberUser"]:checked'))
            .map(function (cb) { return cb.value; });
    }

    closeModal('createLedgerModal');
    document.getElementById('newLedgerTitle').value = '';
    callGasApi('createLedger', {
        userId: currentUser.userId,
        displayName: currentUser.displayName,
        title: title,
        copyFromLedgerId: copyFromLedgerId,
        copyMemberIds: copyMemberIds
    }, shouldCopy ? '正在建立帳本並匯入成員...' : '正在建立帳本...');
}

function submitJoinLedger() {
    const code = document.getElementById('joinInviteCodeInput').value.trim().toUpperCase();
    if (!code) {
        showToast('請輸入邀請碼');
        return;
    }
    closeModal('joinLedgerModal');
    document.getElementById('joinInviteCodeInput').value = '';
    callGasApi('joinLedger', {
        userId: currentUser.userId,
        displayName: currentUser.displayName,
        inviteCode: code
    }, '正在檢查邀請碼...');
}

function openClaimStep1Modal(choiceData) {
    pendingInviteChoiceData = choiceData;
    selectedClaimGuest = null;

    document.getElementById('claimLedgerTitle').textContent = choiceData.title;
    const container = document.getElementById('claimGuestListContainer');

    container.innerHTML = (choiceData.guestMembers || []).map(function (g) {
        return '<button type="button" class="claim-option-btn" onclick="selectGuestToClaim(\'' + g.userId + '\')">' +
            '<div>' +
            '<div style="font-weight:800; font-size:15px;">我是【' + escapeHtml(g.nickname) + '】<span class="guest-badge">未綁定</span></div>' +
            '<div style="font-size:12px; color:var(--text-sub); margin-top:2px;">目前帳本內有 ' + g.expenseCount + ' 筆相關帳務紀錄</div>' +
            '</div>' +
            '<i class="fa-solid fa-arrow-right" style="color:var(--primary);"></i>' +
            '</button>';
    }).join('');

    openModal('claimGuestStep1Modal');
}

function confirmJoinAsNewMember() {
    if (!pendingInviteChoiceData) return;
    const code = pendingInviteChoiceData.invite_code;
    closeModal('claimGuestStep1Modal');
    pendingInviteChoiceData = null;

    callGasApi('completeInviteJoin', {
        userId: currentUser.userId,
        displayName: currentUser.displayName,
        inviteCode: code,
        claimGuestId: ''
    }, '正在以新成員身分加入帳本...');
}

function selectGuestToClaim(guestUserId) {
    if (!pendingInviteChoiceData) return;
    const guest = (pendingInviteChoiceData.guestMembers || []).find(function (g) { return g.userId === guestUserId; });
    if (!guest) return;

    selectedClaimGuest = guest;
    document.getElementById('confirmClaimGuestName').textContent = guest.nickname;
    document.getElementById('confirmClaimKeepName').textContent = guest.nickname;
    document.getElementById('confirmClaimExpenseCount').textContent = guest.expenseCount;

    closeModal('claimGuestStep1Modal');
    openModal('claimGuestStep2Modal');
}

function backToClaimStep1() {
    closeModal('claimGuestStep2Modal');
    if (pendingInviteChoiceData) {
        openModal('claimGuestStep1Modal');
    }
}

function executeClaimGuestJoin() {
    if (!pendingInviteChoiceData || !selectedClaimGuest) return;
    const code = pendingInviteChoiceData.invite_code;
    const guestId = selectedClaimGuest.userId;

    closeModal('claimGuestStep2Modal');
    pendingInviteChoiceData = null;
    selectedClaimGuest = null;

    callGasApi('completeInviteJoin', {
        userId: currentUser.userId,
        displayName: currentUser.displayName,
        inviteCode: code,
        claimGuestId: guestId
    }, '正在認領並合併歷史帳務...');
}

function openRenameLedgerModal() {
    const data = appState && appState.activeLedgerData;
    if (!data || !data.permissions.canRenameLedger) return;
    document.getElementById('renameLedgerInput').value = data.ledger.title || '';
    openModal('renameLedgerModal');
}

function submitRenameLedger() {
    const newTitle = document.getElementById('renameLedgerInput').value.trim();
    if (!newTitle) {
        showToast('請輸入帳本名稱');
        return;
    }
    if (newTitle === appState.activeLedgerData.ledger.title) {
        closeModal('renameLedgerModal');
        return;
    }
    closeModal('renameLedgerModal');
    callGasApi('renameLedger', {
        userId: currentUser.userId,
        ledgerId: appState.activeLedgerId,
        title: newTitle
    }, '正在更新帳本名稱...');
}

// --- 移交帳本管理者權限 ---
function openTransferAdminModal() {
    const data = appState && appState.activeLedgerData;
    if (!data || !data.permissions.canTransferAdmin) return;

    const candidates = (data.members || []).filter(function (m) {
        return m.userId !== currentUser.userId && !m.isGuest;
    });

    const selectEl = document.getElementById('transferAdminSelect');
    const formWrap = document.getElementById('transferAdminFormWrap');
    const emptyHint = document.getElementById('transferAdminEmptyHint');
    const confirmBtn = document.getElementById('btnConfirmTransferAdmin');

    if (candidates.length === 0) {
        selectEl.innerHTML = '';
        formWrap.classList.add('hidden');
        emptyHint.classList.remove('hidden');
        confirmBtn.disabled = true;
    } else {
        selectEl.innerHTML = candidates.map(function (m) {
            return '<option value="' + m.userId + '">' + escapeHtml(m.nickname) + '</option>';
        }).join('');
        formWrap.classList.remove('hidden');
        emptyHint.classList.add('hidden');
        confirmBtn.disabled = false;
    }

    openModal('transferAdminModal');
}

function executeTransferAdmin() {
    const data = appState && appState.activeLedgerData;
    if (!data || !data.permissions.canTransferAdmin) return;

    const newAdminId = document.getElementById('transferAdminSelect').value;
    if (!newAdminId) {
        showToast('請選擇要接替的成員');
        return;
    }

    closeModal('transferAdminModal');
    callGasApi('transferAdmin', {
        userId: currentUser.userId,
        ledgerId: appState.activeLedgerId,
        newAdminUserId: newAdminId
    }, '正在移交帳本管理者權限...');
}

function openDeleteLedgerModal() {
    const data = appState && appState.activeLedgerData;
    if (!data || !data.permissions.canDeleteLedger) return;

    document.getElementById('deleteLedgerTargetTitle').textContent = data.ledger.title;
    document.getElementById('deleteLedgerConfirmInput').value = '';
    document.getElementById('btnConfirmDeleteLedger').disabled = true;
    openModal('deleteLedgerModal');
}

function onDeleteLedgerInputChange() {
    const data = appState && appState.activeLedgerData;
    if (!data) return;
    const typed = document.getElementById('deleteLedgerConfirmInput').value.trim();
    document.getElementById('btnConfirmDeleteLedger').disabled = (typed !== data.ledger.title);
}

function executeDeleteLedger() {
    const data = appState && appState.activeLedgerData;
    if (!data || !data.permissions.canDeleteLedger) return;

    const typed = document.getElementById('deleteLedgerConfirmInput').value.trim();
    if (typed !== data.ledger.title) {
        showToast('請輸入完全相符的帳本名稱');
        return;
    }

    closeModal('deleteLedgerModal');
    callGasApi('deleteLedger', {
        userId: currentUser.userId,
        ledgerId: appState.activeLedgerId,
        confirmTitle: typed
    }, '正在永久刪除帳本與所有資料...');
}

function submitAddGuestMember() {
    const name = document.getElementById('newGuestNameInput').value.trim();
    if (!name) {
        showToast('請輸入代管成員名稱');
        return;
    }
    closeModal('addGuestModal');
    document.getElementById('newGuestNameInput').value = '';
    callGasApi('addGuestMember', {
        userId: currentUser.userId,
        ledgerId: appState.activeLedgerId,
        nickname: name
    }, '正在新增代管成員...');
}

function openNicknameModal(targetUserId) {
    const data = appState && appState.activeLedgerData;
    if (!data) return;
    const targetMember = (data.members || []).find(function (m) { return m.userId === targetUserId; });
    if (!targetMember) return;

    const isSelf = targetUserId === currentUser.userId;
    document.getElementById('editNicknameTargetUserId').value = targetUserId;
    document.getElementById('nicknameModalTitle').textContent = isSelf
        ? '修改我在本帳本的暱稱'
        : '修改「' + targetMember.nickname + '」的顯示暱稱';
    document.getElementById('nicknameModalDesc').textContent = isSelf
        ? '此暱稱僅會套用在「' + data.ledger.title + '」中，方便大家在分帳與結算時辨識。'
        : '身為帳本管理者，你可以協助調整此成員在「' + data.ledger.title + '」中的顯示名稱。';
    document.getElementById('editNicknameInput').value = targetMember.nickname || '';

    openModal('editNicknameModal');
}

function submitUpdateNickname() {
    const targetUserId = document.getElementById('editNicknameTargetUserId').value;
    const newName = document.getElementById('editNicknameInput').value.trim();
    if (!newName) {
        showToast('請輸入要顯示的暱稱');
        return;
    }
    closeModal('editNicknameModal');
    callGasApi('updateNickname', {
        userId: currentUser.userId,
        ledgerId: appState.activeLedgerId,
        targetUserId: targetUserId,
        nickname: newName
    }, '正在更新暱稱...');
}

function openRemoveMemberModal(targetUserId) {
    const data = appState && appState.activeLedgerData;
    if (!data || !data.permissions.isCreator) return;
    const targetMember = (data.members || []).find(function (m) { return m.userId === targetUserId; });
    if (!targetMember) return;

    document.getElementById('removeTargetUserId').value = targetUserId;
    document.getElementById('removeTargetUserName').textContent = targetMember.nickname;
    openModal('removeMemberModal');
}

function executeRemoveMember() {
    const targetUserId = document.getElementById('removeTargetUserId').value;
    if (!targetUserId) return;
    closeModal('removeMemberModal');
    callGasApi('removeMember', {
        userId: currentUser.userId,
        ledgerId: appState.activeLedgerId,
        targetUserId: targetUserId
    }, '正在檢查並移除成員...');
}

// --- 複製純文字結算報表 ---
async function copyTextSettlementReport() {
    const data = appState && appState.activeLedgerData;
    if (!data) return;

    const l = data.ledger;
    const statusText = l.status === 'SETTLED' ? '🔒 已正式結算' : '🟢 記帳進行中試算';
    const lines = [
        '📊【' + l.title + '】結算總覽 (' + statusText + ')',
        '💰 帳本總支出：$' + l.totalAmount.toLocaleString()
    ];

    if (l.hasSubsidy) {
        lines.push('🎁 贊助／補助款折抵：-$' + l.totalSubsidy.toLocaleString());
    }

    lines.push('------------------------');
    lines.push('📌 個人收支淨額：');

    (data.memberSummaries || []).forEach(function (m) {
        const guestSuffix = m.isGuest ? ' (未綁定)' : '';
        const netStr = m.netBalance > 0
            ? '應收 +$' + m.netBalance.toLocaleString()
            : (m.netBalance < 0 ? '應付 -$' + Math.abs(m.netBalance).toLocaleString() : '已打平 $0');
        lines.push('• ' + m.nickname + guestSuffix + '：' + netStr);
    });

    lines.push('------------------------');
    lines.push('💸 最小轉帳結清方式：');
    if (!data.transfers || data.transfers.length === 0) {
        lines.push('目前帳目已平衡，無需轉帳！');
    } else {
        data.transfers.forEach(function (t, idx) {
            lines.push((idx + 1) + '. ' + t.fromName + ' ➔ ' + t.toName + '：$' + t.amount.toLocaleString());
        });
    }

    const reportText = lines.join('\n');
    try {
        await navigator.clipboard.writeText(reportText);
        showToast('已複製純文字結算結果，可直接貼到群組！');
    } catch (e) {
        const tempArea = document.createElement('textarea');
        tempArea.value = reportText;
        document.body.appendChild(tempArea);
        tempArea.select();
        document.execCommand('copy');
        document.body.removeChild(tempArea);
        showToast('已複製純文字結算結果！');
    }
}

// --- 匯出 CSV 明細報表（LINE 內建視窗自動改用外部瀏覽器開啟；含 UTF-8 BOM 防 Excel 亂碼） ---
function escapeCsvCell(val) {
    const str = String(val === null || val === undefined ? '' : val);
    if (/[",\r\n]/.test(str)) {
        return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
}

function exportLedgerCsv() {
    if (isRunningInLineClient()) {
        showToast('正在改用外部瀏覽器開啟，請於瀏覽器中點擊「匯出 CSV」下載', 3500);
        liff.openWindow({ url: window.location.href, external: true });
        return;
    }

    const data = appState && appState.activeLedgerData;
    if (!data) return;

    const l = data.ledger;
    const rows = [];
    const addRow = function (cols) {
        rows.push(cols.map(escapeCsvCell).join(','));
    };

    addRow(['【帳本結算報表】']);
    addRow(['帳本名稱', l.title]);
    addRow(['帳本狀態', l.status === 'SETTLED' ? '已正式結算鎖定' : '進行中（試算）']);
    addRow(['帳本總支出', l.totalAmount]);
    if (l.hasSubsidy) {
        addRow(['贊助／補助款總額', l.totalSubsidy]);
    }
    if (l.settled_at) {
        addRow(['結算時間', l.settled_at]);
    }
    rows.push('');

    addRow(['【一、成員墊付與結算統計】']);
    addRow(['編號', '成員暱稱', '帳號狀態', '已預先支付', '均攤應付總額', '贊助／補助款淨額', '結算淨額（正數應收／負數應付）']);
    (data.memberSummaries || []).forEach(function (m, idx) {
        addRow([
            idx + 1,
            m.nickname,
            m.isGuest ? '未綁定代管' : 'LINE 帳號',
            m.totalPaid,
            m.totalShare,
            m.subsidyNet || 0,
            m.netBalance
        ]);
    });
    rows.push('');

    addRow(['【二、最小轉帳結清路徑】']);
    addRow(['序號', '付款人', '收款人', '應轉帳金額']);
    if (!data.transfers || data.transfers.length === 0) {
        addRow(['-', '目前帳目已平衡，無需轉帳', '', 0]);
    } else {
        data.transfers.forEach(function (t, idx) {
            addRow([idx + 1, t.fromName, t.toName, t.amount]);
        });
    }
    rows.push('');

    addRow(['【三、所有帳務明細】']);
    addRow(['序號', '類型', '建立時間', '項目名稱', '金額', '墊付人／提供人', '分攤或受惠人數', '每人均攤／折抵', '對象成員名單']);
    const chronologicalExpenses = (data.expenses || []).slice().reverse();
    if (chronologicalExpenses.length === 0) {
        addRow(['-', '-', '-', '尚無帳務紀錄', 0, '-', 0, 0, '-']);
    } else {
        chronologicalExpenses.forEach(function (exp, idx) {
            const splitCount = exp.split_users ? exp.split_users.length : 0;
            const perShare = splitCount > 0 ? Math.round((exp.amount / splitCount) * 10) / 10 : 0;
            addRow([
                idx + 1,
                exp.record_type === 'SUBSIDY' ? '贊助／補助款' : '一般支出',
                exp.created_at,
                exp.item_name,
                exp.amount,
                exp.payerName,
                splitCount,
                perShare,
                (exp.splitNames || []).join('、')
            ]);
        });
    }

    const csvContent = '\uFEFF' + rows.join('\r\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);

    const safeTitle = String(l.title || '共享記帳本').replace(/[\\/:*?"<>|]/g, '_');
    const todayStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const fileName = safeTitle + '_結算明細_' + todayStr + '.csv';

    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', fileName);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);

    showToast('已下載「' + fileName + '」');
}

function setExpenseRecordType(type) {
    const normalized = type === 'SUBSIDY' ? 'SUBSIDY' : 'EXPENSE';
    const isSubsidy = normalized === 'SUBSIDY';
    document.getElementById('expRecordType').value = normalized;

    document.getElementById('btnTypeExpense').className = 'record-type-btn' + (!isSubsidy ? ' active-expense' : '');
    document.getElementById('btnTypeSubsidy').className = 'record-type-btn' + (isSubsidy ? ' active-subsidy' : '');

    // 切換為「贊助／補助款」時自動隱藏定期支出相關區塊
    const quickRecSec = document.getElementById('quickRecurringSection');
    const saveRecSec = document.getElementById('saveAsRecurringSection');
    if (isSubsidy) {
        quickRecSec.classList.add('hidden');
        saveRecSec.classList.add('hidden');
        document.getElementById('saveAsRecurringCheckbox').checked = false;
        document.getElementById('recurringBillingDayWrap').classList.add('hidden');
    } else {
        quickRecSec.classList.remove('hidden');
        saveRecSec.classList.remove('hidden');
    }

    document.getElementById('expItemName').placeholder = isSubsidy
        ? '例如：旅遊補助款、長輩贊助金、刷卡回饋'
        : '例如：第一天晚餐、租車費、門票';
    document.getElementById('expAmountLabel').textContent = isSubsidy ? '贊助／補助金額' : '支付金額';
    document.getElementById('expPayerLabel').textContent = isSubsidy ? '誰提供／領取這筆款項' : '誰預先支付（墊付人）';
    document.getElementById('expSplitLabel').textContent = isSubsidy ? '哪些人共同享有折抵（受惠成員）' : '哪些人均攤應付';

    const payerHint = document.getElementById('expPayerHint');
    const subsidyHint = document.getElementById('expSubsidySplitHint');
    const saveBtn = document.getElementById('btnSaveExpense');
    if (isSubsidy) {
        payerHint.classList.remove('hidden');
        subsidyHint.classList.remove('hidden');
        saveBtn.style.background = 'var(--green)';
        saveBtn.style.boxShadow = '0 4px 12px rgba(35, 134, 83, 0.28)';
    } else {
        payerHint.classList.add('hidden');
        subsidyHint.classList.add('hidden');
        saveBtn.style.background = '';
        saveBtn.style.boxShadow = '';
    }

    updateSplitPreview();
}

function openExpenseModal(expenseId, prefillData) {
    const data = appState.activeLedgerData;
    if (!data || !data.permissions.canEdit) return;

    resetDeleteExpenseArm();
    renderQuickRecurringChips();

    document.getElementById('saveAsRecurringCheckbox').checked = false;
    document.getElementById('recurringBillingDayWrap').classList.add('hidden');
    document.getElementById('saveAsRecurringDay').value = '';

    const members = data.members || [];
    const memberIdSet = new Set(members.map(m => m.userId));
    const payerSelect = document.getElementById('expPayerSelect');
    payerSelect.innerHTML = members.map(function (m) {
        const suffix = m.userId === currentUser.userId ? ' (我)' : (m.isGuest ? ' (未綁定)' : '');
        return '<option value="' + m.userId + '">' + escapeHtml(m.nickname) + suffix + '</option>';
    }).join('');

    let targetExpense = null;
    if (expenseId) {
        targetExpense = (data.expenses || []).find(function (e) { return e.expense_id === expenseId; });
    }

    document.getElementById('editExpenseId').value = targetExpense ? targetExpense.expense_id : '';
    document.getElementById('expenseModalTitle').textContent = targetExpense ? '編輯帳務項目' : '新增帳務項目';

    if (targetExpense) {
        document.getElementById('expItemName').value = targetExpense.item_name;
        document.getElementById('expAmount').value = targetExpense.amount;
        payerSelect.value = targetExpense.payer_id;
    } else if (prefillData) {
        document.getElementById('expItemName').value = prefillData.itemName || '';
        document.getElementById('expAmount').value = prefillData.amount || '';
        payerSelect.value = memberIdSet.has(prefillData.payerId) ? prefillData.payerId : currentUser.userId;
    } else {
        document.getElementById('expItemName').value = '';
        document.getElementById('expAmount').value = '';
        payerSelect.value = currentUser.userId;
    }

    let selectedSplitIds = members.map(m => m.userId);
    if (targetExpense) {
        selectedSplitIds = targetExpense.split_users;
    } else if (prefillData && Array.isArray(prefillData.splitUsers) && prefillData.splitUsers.length > 0) {
        const validPrefillSplits = prefillData.splitUsers.filter(uid => memberIdSet.has(uid));
        if (validPrefillSplits.length > 0) selectedSplitIds = validPrefillSplits;
    }
    setExpenseSplitSelection(selectedSplitIds);

    const delBtn = document.getElementById('btnDeleteExpense');
    if (targetExpense) delBtn.classList.remove('hidden');
    else delBtn.classList.add('hidden');

    setExpenseRecordType(targetExpense ? targetExpense.record_type : 'EXPENSE');
    openModal('expenseModal');
}

function setExpenseSplitSelection(selectedIds) {
    const data = appState && appState.activeLedgerData;
    if (!data) return;
    const members = data.members || [];
    const selectedSplitSet = new Set(selectedIds);
    const grid = document.getElementById('splitMembersGrid');

    grid.innerHTML = members.map(function (m) {
        const isChecked = selectedSplitSet.has(m.userId);
        const guestBadge = m.isGuest ? '<span class="guest-badge">未綁定</span>' : '';
        return '<label class="split-chip ' + (isChecked ? 'checked' : '') + '" onclick="onToggleSplitChip(this)">' +
            '<input type="checkbox" name="splitUser" value="' + m.userId + '" ' + (isChecked ? 'checked' : '') + ' onchange="updateSplitPreview()" />' +
            '<span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + escapeHtml(m.nickname) + '</span>' +
            guestBadge +
            '</label>';
    }).join('');
    updateSplitPreview();
}

function onToggleSplitChip(labelEl) {
    setTimeout(function () {
        const cb = labelEl.querySelector('input[type="checkbox"]');
        labelEl.classList.toggle('checked', cb.checked);
        updateSplitPreview();
    }, 0);
}

function toggleSelectAllSplit() {
    const checkboxes = Array.from(document.querySelectorAll('input[name="splitUser"]'));
    const allChecked = checkboxes.every(function (cb) { return cb.checked; });
    checkboxes.forEach(function (cb) {
        cb.checked = !allChecked;
        cb.closest('.split-chip').classList.toggle('checked', cb.checked);
    });
    updateSplitPreview();
}

function updateSplitPreview() {
    const isSubsidy = document.getElementById('expRecordType').value === 'SUBSIDY';
    const amt = Number(document.getElementById('expAmount').value);
    const checkedCount = document.querySelectorAll('input[name="splitUser"]:checked').length;
    const previewEl = document.getElementById('splitPreviewBox');

    if (checkedCount === 0) {
        previewEl.textContent = isSubsidy ? '請至少勾選 1 位受惠成員' : '請至少勾選 1 位均攤成員';
    } else if (!amt || amt <= 0) {
        previewEl.textContent = isSubsidy ? ('已選 ' + checkedCount + ' 人共同受惠') : ('已選 ' + checkedCount + ' 人均攤');
    } else {
        const perPerson = Math.round((amt / checkedCount) * 10) / 10;
        previewEl.innerHTML = isSubsidy
            ? '共 <b>' + checkedCount + '</b> 人受惠，每人折抵 <b>$' + perPerson.toLocaleString() + '</b>'
            : '共 <b>' + checkedCount + '</b> 人均攤，每人約 <b>$' + perPerson.toLocaleString() + '</b>';
    }
}

function submitExpenseForm() {
    const expenseId = document.getElementById('editExpenseId').value;
    const recordType = document.getElementById('expRecordType').value === 'SUBSIDY' ? 'SUBSIDY' : 'EXPENSE';
    const isSubsidy = recordType === 'SUBSIDY';
    const itemName = document.getElementById('expItemName').value.trim();
    const amount = Number(document.getElementById('expAmount').value);
    const payerId = document.getElementById('expPayerSelect').value;
    const splitUsers = Array.from(document.querySelectorAll('input[name="splitUser"]:checked'))
        .map(function (cb) { return cb.value; });

    const saveAsRecurring = !isSubsidy && document.getElementById('saveAsRecurringCheckbox').checked;
    const billingDay = document.getElementById('saveAsRecurringDay').value;

    if (!itemName) {
        showToast('請輸入項目名稱');
        return;
    }
    if (!amount || amount <= 0) {
        showToast('請輸入大於 0 的金額');
        return;
    }
    if (splitUsers.length === 0) {
        showToast(isSubsidy ? '請至少勾選一位受惠成員' : '請至少勾選一位均攤成員');
        return;
    }

    closeModal('expenseModal');
    callGasApi('saveExpense', {
        userId: currentUser.userId,
        ledgerId: appState.activeLedgerId,
        expense: {
            expense_id: expenseId || null,
            record_type: recordType,
            item_name: itemName,
            amount: amount,
            payer_id: payerId,
            split_users: splitUsers,
            save_as_recurring: saveAsRecurring,
            billing_day: billingDay
        }
    }, expenseId ? '正在更新帳務...' : '正在儲存帳務...');
}

// --- 編輯帳務二段式防誤刪 ---
function resetDeleteExpenseArm() {
    deleteExpenseArmed = false;
    clearTimeout(deleteExpenseArmTimer);
    deleteExpenseArmTimer = null;
    const btn = document.getElementById('btnDeleteExpense');
    if (btn) {
        btn.classList.remove('btn-delete-armed');
        btn.innerHTML = '<i class="fa-solid fa-trash"></i> 刪除';
    }
}

function confirmDeleteCurrentExpense() {
    const expenseId = document.getElementById('editExpenseId').value;
    if (!expenseId) return;

    if (!deleteExpenseArmed) {
        deleteExpenseArmed = true;
        const btn = document.getElementById('btnDeleteExpense');
        if (btn) {
            btn.classList.add('btn-delete-armed');
            btn.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> 確定刪除？';
        }
        clearTimeout(deleteExpenseArmTimer);
        deleteExpenseArmTimer = setTimeout(resetDeleteExpenseArm, 3000);
        return;
    }

    resetDeleteExpenseArm();
    closeModal('expenseModal');
    callGasApi('deleteExpense', {
        userId: currentUser.userId,
        ledgerId: appState.activeLedgerId,
        expenseId: expenseId
    }, '正在刪除帳務...');
}

// =========================================================================
// 4.5 個人定期支出項目管理與快速帶入邏輯
// =========================================================================
function getEnrichedRecurringTemplates() {
    const templates = (appState && appState.recurringTemplates) || [];
    const data = appState && appState.activeLedgerData;
    const loggedNameSet = new Set(
        ((data && data.expenses) || [])
            .filter(function (e) { return (e.record_type || 'EXPENSE') !== 'SUBSIDY'; })
            .map(function (e) { return String(e.item_name || '').trim().toLowerCase(); })
    );

    const enriched = templates.map(function (tpl) {
        const isLogged = loggedNameSet.has(String(tpl.item_name || '').trim().toLowerCase());
        return Object.assign({}, tpl, { isLoggedInActive: isLogged });
    });

    enriched.sort(function (a, b) {
        if (a.isLoggedInActive !== b.isLoggedInActive) {
            return a.isLoggedInActive ? 1 : -1;
        }
        const dayA = a.billing_day > 0 ? a.billing_day : 99;
        const dayB = b.billing_day > 0 ? b.billing_day : 99;
        return dayA - dayB;
    });

    return enriched;
}

function renderQuickRecurringChips() {
    const container = document.getElementById('quickRecurringChips');
    const list = getEnrichedRecurringTemplates();

    if (list.length === 0) {
        container.innerHTML =
            '<div style="font-size:12px; color:var(--text-sub); padding:4px 2px;">' +
            '尚未設定定期支出，可勾選下方「同時儲存為範本」或點右上角「管理範本」新增。' +
            '</div>';
        return;
    }

    container.innerHTML = list.map(function (tpl) {
        const statusClass = tpl.isLoggedInActive ? 'logged' : 'pending';
        const statusBadge = tpl.isLoggedInActive
            ? '<span class="tpl-status-pill logged">已記</span>'
            : '<span class="tpl-status-pill pending">待入帳</span>';
        const dayText = tpl.billing_day > 0 ? '每月' + tpl.billing_day + '號・' : '';
        const amtText = tpl.amount > 0 ? '$' + Number(tpl.amount).toLocaleString() : '浮動金額';

        return '<button type="button" class="recurring-chip ' + statusClass + '" data-tpl-id="' + tpl.template_id + '" onclick="applyRecurringTemplateToExpense(\'' + tpl.template_id + '\')">' +
            '<div style="font-weight:700; display:flex; align-items:center; gap:5px;">' +
            '<span>' + escapeHtml(tpl.item_name) + '</span>' + statusBadge +
            '</div>' +
            '<div style="font-size:11px; color:var(--text-sub);">' + dayText + amtText + '</div>' +
            '</button>';
    }).join('');
}

function applyRecurringTemplateToExpense(templateId) {
    const templates = (appState && appState.recurringTemplates) || [];
    const tpl = templates.find(function (t) { return t.template_id === templateId; });
    const data = appState && appState.activeLedgerData;
    if (!tpl || !data) return;

    document.querySelectorAll('.recurring-chip').forEach(function (el) {
        el.classList.toggle('selected', el.dataset.tplId === templateId);
    });

    document.getElementById('expItemName').value = tpl.item_name;
    document.getElementById('expPayerSelect').value = currentUser.userId;

    const ledgerMemberIds = (data.members || []).map(function (m) { return m.userId; });
    const ledgerMemberSet = new Set(ledgerMemberIds);
    const matchedSplits = (tpl.split_users || []).filter(function (uid) { return ledgerMemberSet.has(uid); });
    setExpenseSplitSelection(matchedSplits.length > 0 ? matchedSplits : ledgerMemberIds);

    const amtInput = document.getElementById('expAmount');
    if (tpl.amount > 0) {
        amtInput.value = tpl.amount;
        updateSplitPreview();
        showToast('已帶入「' + tpl.item_name + '」');
    } else {
        amtInput.value = '';
        updateSplitPreview();
        amtInput.focus();
        showToast('已帶入「' + tpl.item_name + '」，請輸入本次金額');
    }
}

function onToggleSaveAsRecurring() {
    const checked = document.getElementById('saveAsRecurringCheckbox').checked;
    const wrap = document.getElementById('recurringBillingDayWrap');
    if (checked) {
        wrap.classList.remove('hidden');
    } else {
        wrap.classList.add('hidden');
    }
}

function openRecurringManageModal(fromExpenseModal) {
    if (fromExpenseModal) {
        closeModal('expenseModal');
    }

    const list = getEnrichedRecurringTemplates();
    const container = document.getElementById('recurringTemplateList');
    const data = appState && appState.activeLedgerData;
    const canQuickUse = Boolean(data && data.permissions && data.permissions.canEdit);

    const memberMap = {};
    ((data && data.members) || []).forEach(function (m) {
        memberMap[m.userId] = m.nickname;
    });

    if (list.length === 0) {
        container.innerHTML =
            '<div style="text-align:center; padding:26px 12px; background:#faf6f5; border:1px dashed var(--border-color); border-radius:12px; color:var(--text-sub); font-size:13px; line-height:1.5;">' +
            '目前尚未建立任何定期支出範本，<br>點擊下方按鈕新增你的固定開銷項目吧！' +
            '</div>';
    } else {
        container.innerHTML = list.map(function (tpl) {
            const statusHtml = data
                ? (tpl.isLoggedInActive
                    ? '<span class="tpl-status-pill logged" style="margin-left:5px;">本帳本已記</span>'
                    : '<span class="tpl-status-pill pending" style="margin-left:5px;">待入帳</span>')
                : '';
            const dayHtml = tpl.billing_day > 0 ? '每月 ' + tpl.billing_day + ' 號扣款・' : '';
            const amtHtml = tpl.amount > 0 ? formatMoney(tpl.amount) : '浮動金額';

            const matchedNames = (tpl.split_users || [])
                .map(function (uid) { return memberMap[uid]; })
                .filter(Boolean);
            const splitDesc = matchedNames.length > 0
                ? '預設均攤：' + escapeHtml(matchedNames.join('、'))
                : ((tpl.split_users && tpl.split_users.length > 0)
                    ? '預設均攤：已記憶 ' + tpl.split_users.length + ' 人（帶入時依本帳本調整）'
                    : '預設均攤：全員均攤');

            const useBtn = canQuickUse
                ? '<button type="button" class="edit-link" style="margin-top:0; background:var(--green-bg); color:var(--green);" onclick="useRecurringFromManage(\'' + tpl.template_id + '\')">' +
                '<i class="fa-solid fa-plus"></i> 帶入記帳</button>'
                : '';

            return '<div class="tpl-card ' + (tpl.isLoggedInActive ? '' : 'pending') + '">' +
                '<div style="flex:1; min-width:0;">' +
                '<div style="font-size:14.5px; font-weight:800; margin-bottom:3px;">' + escapeHtml(tpl.item_name) + statusHtml + '</div>' +
                '<div style="font-size:12px; color:var(--text-sub); line-height:1.45;">' +
                dayHtml + '預設金額：<b>' + amtHtml + '</b><br>' + splitDesc +
                '</div></div>' +
                '<div style="display:flex; flex-direction:column; align-items:flex-end; gap:6px; flex-shrink:0;">' +
                useBtn +
                '<div>' +
                '<button type="button" class="mini-icon-btn" onclick="openRecurringEditModal(\'' + tpl.template_id + '\')" title="編輯範本"><i class="fa-solid fa-pen"></i></button>' +
                '<button type="button" class="mini-icon-btn danger" onclick="openDeleteRecurringModal(\'' + tpl.template_id + '\')" title="刪除範本"><i class="fa-solid fa-trash"></i></button>' +
                '</div></div></div>';
        }).join('');
    }

    openModal('recurringManageModal');
}

function useRecurringFromManage(templateId) {
    closeModal('recurringManageModal');
    openExpenseModal();
    setTimeout(function () {
        applyRecurringTemplateToExpense(templateId);
    }, 30);
}

function openRecurringEditModal(templateId) {
    const templates = (appState && appState.recurringTemplates) || [];
    const target = templateId ? templates.find(function (t) { return t.template_id === templateId; }) : null;

    document.getElementById('editRecurringId').value = target ? target.template_id : '';
    document.getElementById('recurringEditTitle').textContent = target ? '編輯定期支出範本' : '新增定期支出範本';
    document.getElementById('tplItemName').value = target ? target.item_name : '';
    document.getElementById('tplAmount').value = target ? target.amount : '';
    document.getElementById('tplBillingDay').value = (target && target.billing_day > 0) ? target.billing_day : '';

    const data = appState && appState.activeLedgerData;
    const boundMembers = ((data && data.members) || []).filter(function (m) { return !m.isGuest; });
    const savedSplits = (target && target.split_users || []).filter(function (uid) {
        return boundMembers.some(function (m) { return m.userId === uid; });
    });
    const selectedSet = new Set(
        savedSplits.length > 0
            ? savedSplits
            : boundMembers.map(function (m) { return m.userId; })
    );

    const grid = document.getElementById('tplSplitMembersGrid');
    if (boundMembers.length === 0) {
        grid.innerHTML = '<div style="grid-column:1/-1; font-size:12px; color:var(--text-sub);">加入帳本後即可在此勾選已綁定 LINE 的預設均攤成員（目前將預設為全員均攤）。</div>';
    } else {
        grid.innerHTML = boundMembers.map(function (m) {
            const isChecked = selectedSet.has(m.userId);
            return '<label class="split-chip ' + (isChecked ? 'checked' : '') + '" onclick="onToggleTplSplitChip(this)">' +
                '<input type="checkbox" name="tplSplitUser" value="' + m.userId + '" ' + (isChecked ? 'checked' : '') + ' />' +
                '<span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + escapeHtml(m.nickname) + '</span>' +
                '</label>';
        }).join('');
    }

    closeModal('recurringManageModal');
    openModal('recurringEditModal');
}

function onToggleTplSplitChip(labelEl) {
    setTimeout(function () {
        const cb = labelEl.querySelector('input[type="checkbox"]');
        labelEl.classList.toggle('checked', cb.checked);
    }, 0);
}

function toggleSelectAllTplSplit() {
    const checkboxes = Array.from(document.querySelectorAll('input[name="tplSplitUser"]'));
    const allChecked = checkboxes.every(function (cb) { return cb.checked; });
    checkboxes.forEach(function (cb) {
        cb.checked = !allChecked;
        cb.closest('.split-chip').classList.toggle('checked', cb.checked);
    });
}

function backToRecurringManage() {
    closeModal('recurringEditModal');
    openRecurringManageModal();
}

function submitRecurringTemplateForm() {
    const templateId = document.getElementById('editRecurringId').value;
    const itemName = document.getElementById('tplItemName').value.trim();
    const rawAmt = document.getElementById('tplAmount').value;
    const amount = rawAmt === '' ? 0 : Number(rawAmt);
    const billingDay = document.getElementById('tplBillingDay').value;
    const splitUsers = Array.from(document.querySelectorAll('input[name="tplSplitUser"]:checked'))
        .map(function (cb) { return cb.value; });

    if (!itemName) {
        showToast('請輸入定期項目名稱');
        return;
    }
    if (isNaN(amount) || amount < 0) {
        showToast('預設金額不可小於 0');
        return;
    }

    closeModal('recurringEditModal');
    reopenRecurringManage = true;
    callGasApi('saveRecurringTemplate', {
        userId: currentUser.userId,
        template: {
            template_id: templateId || null,
            item_name: itemName,
            amount: amount,
            billing_day: billingDay,
            split_users: splitUsers
        }
    }, '正在儲存定期支出範本...');
}

function openDeleteRecurringModal(templateId) {
    const templates = (appState && appState.recurringTemplates) || [];
    const target = templates.find(function (t) { return t.template_id === templateId; });
    if (!target) return;

    document.getElementById('deleteRecurringTargetId').value = templateId;
    document.getElementById('deleteRecurringTargetName').textContent = target.item_name;
    closeModal('recurringManageModal');
    openModal('confirmDeleteRecurringModal');
}

function backToRecurringManageFromDelete() {
    closeModal('confirmDeleteRecurringModal');
    openRecurringManageModal();
}

function executeDeleteRecurringTemplate() {
    const templateId = document.getElementById('deleteRecurringTargetId').value;
    if (!templateId) return;

    closeModal('confirmDeleteRecurringModal');
    reopenRecurringManage = true;
    callGasApi('deleteRecurringTemplate', {
        userId: currentUser.userId,
        templateId: templateId
    }, '正在刪除定期支出範本...');
}

// =========================================================================
// 4.6 帳務操作歷程（按需分頁載入，每次 10 筆，附帶 ID Token）
// =========================================================================
let activityLogState = {
    filter: 'ALL',
    offset: 0,
    total: 0,
    hasMore: false,
    loading: false,
    items: []
};

function openActivityLogModal() {
    if (!appState || !appState.activeLedgerId) return;
    activityLogState = {
        filter: 'ALL',
        offset: 0,
        total: 0,
        hasMore: false,
        loading: false,
        items: []
    };
    updateLogFilterButtons();
    document.getElementById('activityLogList').innerHTML = '';
    document.getElementById('activityLogCountHint').textContent = '';
    document.getElementById('btnLoadMoreLogs').classList.add('hidden');
    openModal('activityLogModal');
    fetchActivityLogsPage(false);
}

function switchActivityLogFilter(filterMode) {
    if (activityLogState.loading || activityLogState.filter === filterMode) return;
    activityLogState.filter = filterMode;
    activityLogState.offset = 0;
    activityLogState.items = [];
    activityLogState.hasMore = false;
    updateLogFilterButtons();
    document.getElementById('activityLogList').innerHTML = '';
    document.getElementById('btnLoadMoreLogs').classList.add('hidden');
    fetchActivityLogsPage(false);
}

function updateLogFilterButtons() {
    document.getElementById('logFilterAll').classList.toggle('active', activityLogState.filter === 'ALL');
    document.getElementById('logFilterModify').classList.toggle('active', activityLogState.filter === 'MODIFY_ONLY');
}

function loadMoreActivityLogs() {
    if (activityLogState.loading || !activityLogState.hasMore) return;
    fetchActivityLogsPage(true);
}

async function fetchActivityLogsPage(isAppend) {
    activityLogState.loading = true;
    const loadingEl = document.getElementById('activityLogLoading');
    const loadMoreBtn = document.getElementById('btnLoadMoreLogs');
    loadingEl.classList.remove('hidden');
    loadMoreBtn.classList.add('hidden');

    try {
        const response = await fetch(GAS_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({
                api_action: 'getActivityLogs',
                idToken: getLiffIdTokenSafe(),
                accessToken: getLiffAccessTokenSafe(),
                userId: currentUser.userId,
                ledgerId: appState.activeLedgerId,
                filter: activityLogState.filter,
                offset: activityLogState.offset,
                limit: 10
            })
        });

        if (!response.ok) throw new Error('伺服器連線異常 (HTTP ' + response.status + ')');
        const json = await response.json();
        if (!json.ok) {
            if (json.error === 'AUTH_EXPIRED' && !isMockMode && typeof liff !== 'undefined') {
                showToast('LINE 登入憑證已過期，正在重新驗證...', 3000);
                setTimeout(function () {
                    if (!forceExternalRelogin()) {
                        showToast('登入狀態異常，請清除瀏覽器網站資料後重開', 4500);
                    }
                }, 600);
                return;
            }
            throw new Error(json.error || '讀取歷程失敗');
        }

        const resData = json.data || {};
        const newItems = resData.logs || [];
        activityLogState.items = isAppend ? activityLogState.items.concat(newItems) : newItems;
        activityLogState.offset = resData.nextOffset || activityLogState.items.length;
        activityLogState.total = resData.total || 0;
        activityLogState.hasMore = Boolean(resData.hasMore);

        renderActivityLogList();
    } catch (err) {
        showToast(err.message || '載入歷程失敗');
    } finally {
        activityLogState.loading = false;
        loadingEl.classList.add('hidden');
    }
}

function renderActivityLogList() {
    const container = document.getElementById('activityLogList');
    const countHint = document.getElementById('activityLogCountHint');
    const loadMoreBtn = document.getElementById('btnLoadMoreLogs');
    const items = activityLogState.items;

    if (items.length === 0) {
        countHint.textContent = '';
        container.innerHTML =
            '<div style="text-align:center; padding:26px 12px; background:#faf6f5; border:1px dashed var(--border-color); border-radius:12px; color:var(--text-sub); font-size:13px;">' +
            (activityLogState.filter === 'MODIFY_ONLY'
                ? '目前尚無任何「修改」或「刪除」帳務的紀錄。'
                : '目前尚無帳務操作歷程（新建立、修改或刪除的帳務皆會記錄於此）。') +
            '</div>';
        loadMoreBtn.classList.add('hidden');
        return;
    }

    countHint.textContent = '目前顯示 ' + items.length + ' / 共 ' + activityLogState.total + ' 筆紀錄';
    container.innerHTML = items.map(function (log) {
        let cardCls = 'type-add';
        let badgeCls = 'add';
        let badgeLabel = '新增';
        if (log.action_type === 'EXP_EDIT') {
            cardCls = 'type-edit';
            badgeCls = 'edit';
            badgeLabel = '編輯';
        } else if (log.action_type === 'EXP_DEL') {
            cardCls = 'type-del';
            badgeCls = 'del';
            badgeLabel = '刪除';
        }

        const sourceBadge = log.source === 'LINE'
            ? '<span class="log-source-pill"><i class="fa-brands fa-line"></i> LINE 快記</span>'
            : '';

        return '<div class="log-card ' + cardCls + '">' +
            '<div class="log-card-top">' +
            '<div><span class="log-badge ' + badgeCls + '">' + badgeLabel + '</span>' + sourceBadge + '</div>' +
            '<span style="font-size:11px; color:var(--text-sub);">' + escapeHtml(log.created_at) + '</span>' +
            '</div>' +
            '<div style="font-size:13.5px; font-weight:800; color:var(--text-main); margin-bottom:3px;">' +
            escapeHtml(log.operator_name) + ' <span style="font-weight:400; color:var(--text-sub);">操作</span>「' + escapeHtml(log.target_name) + '」' +
            '</div>' +
            '<div style="font-size:12px; color:var(--text-sub); line-height:1.5;">' +
            escapeHtml(log.detail_summary) +
            '</div></div>';
    }).join('');

    if (activityLogState.hasMore) {
        const remain = activityLogState.total - items.length;
        loadMoreBtn.innerHTML = '<i class="fa-solid fa-angles-down"></i> 載入更早紀錄（還有 ' + remain + ' 筆）';
        loadMoreBtn.classList.remove('hidden');
    } else {
        loadMoreBtn.classList.add('hidden');
    }
}

function openShareModal() {
    const ledger = appState.activeLedgerData.ledger;
    document.getElementById('modalInviteCodeBadge').textContent = ledger.invite_code;

    if (isMockMode) {
        const baseUrl = window.location.origin + window.location.pathname;
        document.getElementById('shareUrlInput').value =
            baseUrl + '?mock_user=TEST_U02&mock_name=旅伴小華&invite=' + ledger.invite_code;
    } else {
        document.getElementById('shareUrlInput').value = ledger.invite_url;
    }

    const lineShareBtn = document.getElementById('btnLineShare');
    if (!isMockMode && liff.isApiAvailable && liff.isApiAvailable('shareTargetPicker')) {
        lineShareBtn.classList.remove('hidden');
    } else {
        lineShareBtn.classList.add('hidden');
    }
    openModal('shareInviteModal');
}

async function copyInviteUrl() {
    const input = document.getElementById('shareUrlInput');
    try {
        await navigator.clipboard.writeText(input.value);
        showToast('已複製邀請連結！');
    } catch (e) {
        input.select();
        document.execCommand('copy');
        showToast('已複製邀請連結！');
    }
}

async function shareViaLinePicker() {
    const ledger = appState.activeLedgerData.ledger;
    try {
        await liff.shareTargetPicker([
            {
                type: 'text',
                text: '邀請你加入共享記帳本「' + ledger.title + '」！點擊連結立即加入記帳：\n' + ledger.invite_url
            }
        ]);
        closeModal('shareInviteModal');
    } catch (err) {
        showToast('已取消傳送或無法開啟好友選單');
    }
}

function openConfirmSettleModal() {
    const cb = document.getElementById('settleNotifyCheckbox');
    if (cb) cb.checked = true;
    openModal('confirmSettleModal');
}

function executeSettleLedger() {
    const cb = document.getElementById('settleNotifyCheckbox');
    const notifyMembers = cb ? cb.checked : true;
    closeModal('confirmSettleModal');
    callGasApi('settleLedger', {
        userId: currentUser.userId,
        ledgerId: appState.activeLedgerId,
        notifyMembers: notifyMembers
    }, notifyMembers ? '正在結算鎖定並推播通知...' : '正在靜默結算並鎖定帳本...');
}

// =========================================================================
// 5. UI 輔助工具（點擊遮罩、Escape 鍵與手機裝置返回鍵只關閉彈窗不跳出網頁）
// =========================================================================
function getOpenModals() {
    return Array.from(document.querySelectorAll('.modal-backdrop.open'));
}

function scheduleModalHistoryCleanup() {
    clearTimeout(modalHistorySyncTimer);
    modalHistorySyncTimer = setTimeout(function () {
        if (getOpenModals().length === 0 && hasModalHistoryGuard) {
            hasModalHistoryGuard = false;
            ignoreNextPopState = true;
            window.history.back();
        }
    }, 0);
}

function openModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;

    clearTimeout(modalHistorySyncTimer);
    modal.classList.add('open');

    const scrollArea = modal.querySelector('.modal-body') || modal.querySelector('.modal-sheet');
    if (scrollArea) scrollArea.scrollTop = 0;

    if (!hasModalHistoryGuard && window.history && window.history.pushState) {
        try {
            window.history.pushState({ modalGuard: true }, '', window.location.href);
            hasModalHistoryGuard = true;
        } catch (e) { }
    }
}

function closeModal(id, fromPopState) {
    const modal = document.getElementById(id);
    if (modal) {
        modal.classList.remove('open');
    }
    if (id === 'expenseModal') {
        resetDeleteExpenseArm();
    }
    if (!fromPopState) {
        scheduleModalHistoryCleanup();
    }
}

function closeAllOpenModals(fromPopState) {
    getOpenModals().forEach(function (el) {
        el.classList.remove('open');
    });
    resetDeleteExpenseArm();
    if (!fromPopState) {
        scheduleModalHistoryCleanup();
    }
}

document.querySelectorAll('.modal-backdrop').forEach(function (backdrop) {
    backdrop.addEventListener('click', function (e) {
        if (e.target === backdrop) {
            closeModal(backdrop.id);
        }
    });
});

document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && getOpenModals().length > 0) {
        closeAllOpenModals(false);
    }
});

window.addEventListener('popstate', function () {
    if (ignoreNextPopState) {
        ignoreNextPopState = false;
        return;
    }
    if (hasModalHistoryGuard) {
        hasModalHistoryGuard = false;
        if (getOpenModals().length > 0) {
            closeAllOpenModals(true);
        }
    }
});

function showLoading(text) {
    document.getElementById('loadingText').textContent = text || '載入中...';
    document.getElementById('loadingOverlay').classList.remove('hidden');
}

function hideLoading() {
    document.getElementById('loadingOverlay').classList.add('hidden');
}

let toastTimer = null;
function showToast(msg, duration) {
    const el = document.getElementById('toastBox');
    el.textContent = msg;
    el.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
        el.style.display = 'none';
    }, duration || 3000);
}

function formatMoney(num) {
    return '$' + Math.round(Number(num || 0)).toLocaleString();
}

function formatNetMoney(num) {
    const n = Math.round(Number(num || 0));
    if (n > 0) return '應收 +$' + n.toLocaleString();
    if (n < 0) return '應付 -$' + Math.abs(n).toLocaleString();
    return '$0 (已打平)';
}

function formatSignedMoney(num) {
    const n = Math.round(Number(num || 0));
    if (n > 0) return '+$' + n.toLocaleString();
    if (n < 0) return '-$' + Math.abs(n).toLocaleString();
    return '$0';
}

function escapeHtml(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
