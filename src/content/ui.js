(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	function formatSeconds(totalSeconds) {
		const minutes = Math.floor(totalSeconds / 60);
		const seconds = totalSeconds % 60;
		return `${minutes}:${String(seconds).padStart(2, '0')}`;
	}

	function formatResetCountdown(timestampMs) {
		const diffMs = timestampMs - Date.now();
		if (diffMs <= 0) return '0s';
		const totalSeconds = Math.floor(diffMs / 1000);
		if (totalSeconds < 60) return `${totalSeconds}s`;
		const totalMinutes = Math.round(totalSeconds / 60);
		if (totalMinutes < 60) return `${totalMinutes}m`;
		const hours = Math.floor(totalMinutes / 60);
		const minutes = totalMinutes % 60;
		if (hours < 24) return `${hours}h ${minutes}m`;
		const days = Math.floor(hours / 24);
		const remHours = hours % 24;
		return `${days}d ${remHours}h`;
	}

	function setupTooltip(element, tooltip, { topOffset = 10 } = {}) {
		if (!element || !tooltip) return;
		if (element.hasAttribute('data-tooltip-setup')) return;
		element.setAttribute('data-tooltip-setup', 'true');
		element.classList.add('cc-tooltipTrigger');

		let pressTimer;
		let hideTimer;

		const show = () => {
			const rect = element.getBoundingClientRect();
			tooltip.style.opacity = '1';
			const tipRect = tooltip.getBoundingClientRect();
			let left = rect.left + rect.width / 2;
			if (left + tipRect.width / 2 > window.innerWidth) left = window.innerWidth - tipRect.width / 2 - 10;
			if (left - tipRect.width / 2 < 0) left = tipRect.width / 2 + 10;
			let top = rect.top - tipRect.height - topOffset;
			if (top < 10) top = rect.bottom + 10;
			tooltip.style.left = `${left}px`;
			tooltip.style.top = `${top}px`;
			tooltip.style.transform = 'translateX(-50%)';
		};

		const hide = () => {
			tooltip.style.opacity = '0';
			clearTimeout(hideTimer);
		};

		element.addEventListener('pointerdown', (e) => {
			if (e.pointerType === 'touch' || e.pointerType === 'pen') {
				pressTimer = setTimeout(() => {
					show();
					hideTimer = setTimeout(hide, 3000);
				}, 500);
			}
		});
		element.addEventListener('pointerup', () => clearTimeout(pressTimer));
		element.addEventListener('pointercancel', () => { clearTimeout(pressTimer); hide(); });
		element.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') show(); });
		element.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') hide(); });
	}

	function makeTooltip(text) {
		const tip = document.createElement('div');
		tip.className = 'bg-bg-500 text-text-000 cc-tooltip';
		tip.textContent = text;
		document.body.appendChild(tip);
		return tip;
	}

	// Battery color: green(0%) → amber(60%) → orange(85%) → red(100%)
	function getBatteryColor(pct) {
		const stops = [
			{ at: 0,   r: 34,  g: 197, b: 94  },
			{ at: 60,  r: 234, g: 179, b: 8   },
			{ at: 85,  r: 249, g: 115, b: 22  },
			{ at: 100, r: 239, g: 68,  b: 68  },
		];
		let lo = stops[0], hi = stops[stops.length - 1];
		for (let i = 0; i < stops.length - 1; i++) {
			if (pct >= stops[i].at && pct <= stops[i + 1].at) {
				lo = stops[i]; hi = stops[i + 1]; break;
			}
		}
		const t = lo.at === hi.at ? 0 : (pct - lo.at) / (hi.at - lo.at);
		const r = Math.round(lo.r + (hi.r - lo.r) * t);
		const g = Math.round(lo.g + (hi.g - lo.g) * t);
		const b = Math.round(lo.b + (hi.b - lo.b) * t);
		return `rgb(${r},${g},${b})`;
	}

	// Build a battery DOM element; nub on RIGHT for rightward-pointing horizontal battery
	function makeBattery() {
		const root = document.createElement('div');
		root.className = 'cc-bat';

		const body = document.createElement('div');
		body.className = 'cc-bat__body';

		const fill = document.createElement('div');
		fill.className = 'cc-bat__fill';

		// 3 tick marks inside the body
		const ticks = document.createElement('div');
		ticks.className = 'cc-bat__ticks';
		for (let i = 0; i < 3; i++) {
			const t = document.createElement('div');
			t.className = 'cc-bat__tick';
			ticks.appendChild(t);
		}

		const pctEl = document.createElement('div');
		pctEl.className = 'cc-bat__pct';

		body.appendChild(fill);
		body.appendChild(ticks);
		body.appendChild(pctEl);

		// Nub AFTER body = appears on the RIGHT
		const nub = document.createElement('div');
		nub.className = 'cc-bat__nub';

		root.appendChild(body);
		root.appendChild(nub);

		return { root, fill, pctEl, body };
	}

	class CounterUI {
		constructor({ onUsageRefresh } = {}) {
			this.onUsageRefresh = onUsageRefresh || null;

			this.headerContainer = null;
			this.headerDisplay = null;
			this.lengthGroup = null;
			this.lengthDisplay = null;
			this.cachedDisplay = null;
			this.lengthBar = null;
			this.lengthTooltip = null;
			this.lastCachedUntilMs = null;
			this.pendingCache = false;

			this.usageLine = null;
			this.sessionUsageSpan = null;
			this.weeklyUsageSpan = null;
			this.sessionResetMs = null;
			this.weeklyResetMs = null;
			this.sessionWindowStartMs = null;
			this.weeklyWindowStartMs = null;
			this.refreshingUsage = false;

			// Battery references
			this._sessionBat = null;
			this._weeklyBat = null;

			this.domObserver = null;
		}

		getProgressChrome() {
			const root = document.documentElement;
			const modeDark = root.dataset?.mode === 'dark';
			const modeLight = root.dataset?.mode === 'light';
			const isDark = modeDark && !modeLight;
			return {
				strokeColor: isDark ? CC.COLORS.PROGRESS_OUTLINE_DARK : CC.COLORS.PROGRESS_OUTLINE_LIGHT,
				fillColor: isDark ? CC.COLORS.PROGRESS_FILL_DARK : CC.COLORS.PROGRESS_FILL_LIGHT,
				markerColor: isDark ? CC.COLORS.PROGRESS_MARKER_DARK : CC.COLORS.PROGRESS_MARKER_LIGHT,
				boldColor: isDark ? CC.COLORS.BOLD_DARK : CC.COLORS.BOLD_LIGHT
			};
		}

		refreshProgressChrome() {
			const { strokeColor, fillColor } = this.getProgressChrome();
			if (this.lengthBar) {
				this.lengthBar.style.setProperty('--cc-stroke', strokeColor);
				this.lengthBar.style.setProperty('--cc-fill', fillColor);
			}
		}

		initialize() {
			this.headerContainer = document.createElement('div');
			this.headerContainer.className = 'text-text-500 text-xs !px-1 cc-header';

			this.headerDisplay = document.createElement('span');
			this.headerDisplay.className = 'cc-headerItem';

			this.lengthGroup = document.createElement('span');
			this.lengthDisplay = document.createElement('span');
			this.cachedDisplay = document.createElement('span');
			this.cacheTimeSpan = null;

			this.lengthGroup.appendChild(this.lengthDisplay);
			this.headerDisplay.appendChild(this.lengthGroup);

			this._initUsageLine();
			this._setupTooltips();
			this._observeDom();
			this._observeTheme();
		}

		_observeTheme() {
			const observer = new MutationObserver(() => this.refreshProgressChrome());
			observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode'] });
		}

		_observeDom() {
			let usageReattachPending = false;
			let headerReattachPending = false;

			this.domObserver = new MutationObserver(() => {
				const usageMissing = this.usageLine && !document.contains(this.usageLine);
				const headerMissing = !document.contains(this.headerContainer);

				if (usageMissing && !usageReattachPending) {
					usageReattachPending = true;
					CC.waitForElement(CC.DOM.MODEL_SELECTOR_DROPDOWN, 60000).then((el) => {
						usageReattachPending = false;
						if (el) this.attachUsageLine();
					});
				}
				if (headerMissing && !headerReattachPending) {
					headerReattachPending = true;
					CC.waitForElement(CC.DOM.CHAT_MENU_TRIGGER, 60000).then((el) => {
						headerReattachPending = false;
						if (el) this.attachHeader();
					});
				}
			});
			this.domObserver.observe(document.body, { childList: true, subtree: true });
		}

		_initUsageLine() {
			this.usageLine = document.createElement('div');
			this.usageLine.className = 'cc-usageRow cc-hidden';

			// Session battery (horizontal, label above)
			this._sessionBat = makeBattery();
			this.sessionUsageSpan = document.createElement('span');
			this.sessionUsageSpan.className = 'cc-bat__label';
			const sessionWrapper = document.createElement('div');
			sessionWrapper.className = 'cc-batWrapper';
			sessionWrapper.appendChild(this.sessionUsageSpan);
			sessionWrapper.appendChild(this._sessionBat.root);

			// Vertical divider
			const divider = document.createElement('div');
			divider.className = 'cc-batDivider';

			// Weekly battery (horizontal, label above)
			this._weeklyBat = makeBattery();
			this.weeklyUsageSpan = document.createElement('span');
			this.weeklyUsageSpan.className = 'cc-bat__label';
			const weeklyWrapper = document.createElement('div');
			weeklyWrapper.className = 'cc-batWrapper';
			weeklyWrapper.appendChild(this.weeklyUsageSpan);
			weeklyWrapper.appendChild(this._weeklyBat.root);

			// Side-by-side row
			const batRow = document.createElement('div');
			batRow.className = 'cc-batRow';
			batRow.appendChild(sessionWrapper);
			batRow.appendChild(divider);
			batRow.appendChild(weeklyWrapper);
			this.usageLine.appendChild(batRow);

			this.usageLine.addEventListener('click', async () => {
				if (!this.onUsageRefresh || this.refreshingUsage) return;
				this.refreshingUsage = true;
				this.usageLine.classList.add('cc-usageRow--dim');
				try {
					await this.onUsageRefresh();
				} finally {
					this.usageLine.classList.remove('cc-usageRow--dim');
					this.refreshingUsage = false;
				}
			});
		}

		_setupTooltips() {
			this.lengthTooltip = makeTooltip(
				"Token count (exact after sending a message, estimated before).\nEstimates use a generic tokenizer and may differ from Claude's count.\nBecomes invalid after context compaction.\nBar scale: 200k tokens (Claude's maximum context length)."
			);
			setupTooltip(this.lengthGroup, this.lengthTooltip, { topOffset: 8 });
			setupTooltip(this.cachedDisplay, makeTooltip("Messages sent while cached are significantly cheaper."), { topOffset: 8 });
			setupTooltip(this._sessionBat.root, makeTooltip("5-hour session window.\nBattery fill = % of session limit used.\nGreen → safe, Amber → moderate, Red → near limit."), { topOffset: 8 });
			setupTooltip(this._weeklyBat.root, makeTooltip("7-day usage window.\nBattery fill = % of weekly limit used.\nGreen → safe, Amber → moderate, Red → near limit."), { topOffset: 8 });
		}

		attach() {
			this.attachHeader();
			this.attachUsageLine();
			this.refreshProgressChrome();
		}

		attachHeader() {
			const chatMenu = document.querySelector(CC.DOM.CHAT_MENU_TRIGGER);
			if (!chatMenu) return;
			const anchor = chatMenu.closest(CC.DOM.CHAT_PROJECT_WRAPPER) || chatMenu.parentElement;
			if (!anchor) return;
			if (anchor.nextElementSibling !== this.headerContainer) {
				anchor.after(this.headerContainer);
			}
			this._renderHeader();
			this.refreshProgressChrome();
		}

		attachUsageLine() {
			if (!this.usageLine) return;
			const modelSelector = document.querySelector(CC.DOM.MODEL_SELECTOR_DROPDOWN);
			if (!modelSelector) return;
			const gridContainer = modelSelector.closest('[data-testid="chat-input-grid-container"]');
			const gridArea = modelSelector.closest('[data-testid="chat-input-grid-area"]');
			const findToolbarRow = (el, stopAt) => {
				let cur = el;
				while (cur && cur !== document.body) {
					if (stopAt && cur === stopAt) break;
					if (cur !== el && cur.nodeType === 1) {
						const style = window.getComputedStyle(cur);
						if (style.display === 'flex' && style.flexDirection === 'row') {
							const buttons = cur.querySelectorAll('button').length;
							if (buttons > 1) return cur;
						}
					}
					cur = cur.parentElement;
				}
				return null;
			};
			const toolbarRow =
				(gridContainer ? findToolbarRow(modelSelector, gridArea || gridContainer) : null) ||
				findToolbarRow(modelSelector) ||
				modelSelector.parentElement?.parentElement?.parentElement;
			if (!toolbarRow) return;
			if (toolbarRow.nextElementSibling !== this.usageLine) {
				toolbarRow.after(this.usageLine);
			}
			this.refreshProgressChrome();
		}

		updateCachedUntil(cachedUntil) {
			const now = Date.now();
			if (typeof cachedUntil === 'number' && cachedUntil > now) {
				this.lastCachedUntilMs = cachedUntil;
				const secondsLeft = Math.max(0, Math.ceil((cachedUntil - now) / 1000));
				const { boldColor } = this.getProgressChrome();
				this.cacheTimeSpan = Object.assign(document.createElement('span'), {
					className: 'cc-cacheTime',
					textContent: formatSeconds(secondsLeft)
				});
				this.cacheTimeSpan.style.color = boldColor;
				this.cachedDisplay.replaceChildren(document.createTextNode('cached for\u00A0'), this.cacheTimeSpan);
				this._renderHeader();
			}
		}

		setPendingCache(pending) {
			this.pendingCache = pending;
			if (this.cacheTimeSpan) {
				if (pending) {
					this.cacheTimeSpan.style.color = '';
				} else {
					const { boldColor } = this.getProgressChrome();
					this.cacheTimeSpan.style.color = boldColor;
				}
			}
		}

		setRealTokenCount({ inputTokens, cacheReadTokens, cacheCreationTokens } = {}) {
			if (typeof inputTokens !== 'number') return;
			const pct = Math.max(0, Math.min(100, (inputTokens / CC.CONST.CONTEXT_LIMIT_TOKENS) * 100));
			this.lengthDisplay.textContent = `${inputTokens.toLocaleString()} tokens`;

			const cacheConfirmed = (cacheCreationTokens > 0) || (cacheReadTokens > 0);
			if (cacheConfirmed && this.cacheTimeSpan === null && !this.lastCachedUntilMs) {
				const { boldColor } = this.getProgressChrome();
				this.cacheTimeSpan = Object.assign(document.createElement('span'), {
					className: 'cc-cacheTime',
					textContent: 'active'
				});
				this.cacheTimeSpan.style.color = boldColor;
				this.cachedDisplay.replaceChildren(document.createTextNode('cached\u00A0'), this.cacheTimeSpan);
			}

			const isFull = pct >= 99.5;
			if (isFull) {
				this.lengthDisplay.style.opacity = '0.5';
				this.lengthBar = null;
				this.lengthGroup.replaceChildren(this.lengthDisplay);
			} else {
				this.lengthDisplay.style.opacity = '';
				const bar = document.createElement('div');
				bar.className = 'cc-bar cc-bar--mini';
				this.lengthBar = bar;
				const fill = document.createElement('div');
				fill.className = 'cc-bar__fill';
				fill.style.width = `${pct}%`;
				bar.appendChild(fill);
				this.refreshProgressChrome();
				const barContainer = document.createElement('span');
				barContainer.className = 'inline-flex items-center';
				barContainer.appendChild(bar);
				this.lengthGroup.replaceChildren(this.lengthDisplay, document.createTextNode('\u00A0\u00A0'), barContainer);
			}
			this._renderHeader();
		}

		setConversationMetrics({ totalTokens, cachedUntil } = {}) {
			this.pendingCache = false;
			if (typeof totalTokens !== 'number') {
				this.lengthDisplay.textContent = '';
				this.cachedDisplay.textContent = '';
				this.lastCachedUntilMs = null;
				this._renderHeader();
				return;
			}

			const pct = Math.max(0, Math.min(100, (totalTokens / CC.CONST.CONTEXT_LIMIT_TOKENS) * 100));
			this.lengthDisplay.textContent = `~${totalTokens.toLocaleString()} tokens`;

			const isFull = pct >= 99.5;
			if (isFull) {
				this.lengthDisplay.style.opacity = '0.5';
				this.lengthBar = null;
				this.lengthGroup.replaceChildren(this.lengthDisplay);
				if (this.lengthTooltip) {
					this.lengthTooltip.textContent =
						"Approximate tokens (excludes system prompt).\nUses a generic tokenizer, may differ from Claude's count.\nThis count is invalid after compaction.";
				}
			} else {
				this.lengthDisplay.style.opacity = '';
				const bar = document.createElement('div');
				bar.className = 'cc-bar cc-bar--mini';
				this.lengthBar = bar;
				const fill = document.createElement('div');
				fill.className = 'cc-bar__fill';
				fill.style.width = `${pct}%`;
				bar.appendChild(fill);
				this.refreshProgressChrome();
				const barContainer = document.createElement('span');
				barContainer.className = 'inline-flex items-center';
				barContainer.appendChild(bar);
				this.lengthGroup.replaceChildren(this.lengthDisplay, document.createTextNode('\u00A0\u00A0'), barContainer);
			}

			const now = Date.now();
			if (typeof cachedUntil === 'number' && cachedUntil > now) {
				this.lastCachedUntilMs = cachedUntil;
				const secondsLeft = Math.max(0, Math.ceil((cachedUntil - now) / 1000));
				const { boldColor } = this.getProgressChrome();
				this.cacheTimeSpan = Object.assign(document.createElement('span'), {
					className: 'cc-cacheTime',
					textContent: formatSeconds(secondsLeft)
				});
				this.cacheTimeSpan.style.color = boldColor;
				this.cachedDisplay.replaceChildren(document.createTextNode('cached for\u00A0'), this.cacheTimeSpan);
			} else {
				this.lastCachedUntilMs = null;
				this.cacheTimeSpan = null;
				this.cachedDisplay.textContent = '';
			}
			this._renderHeader();
		}

		_renderHeader() {
			this.headerContainer.replaceChildren();
			const hasTokens = !!this.lengthDisplay.textContent;
			const hasCache = !!this.cachedDisplay.textContent;
			if (!hasTokens) return;
			if (hasCache) {
				const gap = this.lengthBar ? '\u00A0\u00A0' : '\u00A0';
				this.headerDisplay.replaceChildren(
					this.lengthGroup,
					document.createTextNode(gap),
					this.cachedDisplay
				);
			} else {
				this.headerDisplay.replaceChildren(this.lengthGroup);
			}
			this.headerContainer.appendChild(this.headerDisplay);
		}

		_applyBattery(bat, rawPct, labelEl, resetMs, prefix) {
			const pct = Math.max(0, Math.min(100, rawPct));
			const color = getBatteryColor(pct);

			// Solid color fill — same color used everywhere, fully dynamic
			bat.fill.style.width = `${pct}%`;
			bat.fill.style.background = color;

			// Percentage text — white on top of fill, color when unfilled
			bat.pctEl.textContent = `${Math.round(pct)}%`;
			bat.pctEl.style.color = pct > 45 ? 'rgba(255,255,255,0.95)' : color;

			// Body border & glow — same dynamic color
			bat.body.style.borderColor = `${color}99`;
			bat.body.style.boxShadow = `0 0 10px ${color}66, 0 0 3px ${color}44, inset 0 0 8px rgba(0,0,0,0.4)`;

			// Nub — same dynamic color
			const nub = bat.root.querySelector('.cc-bat__nub');
			if (nub) {
				nub.style.background = color;
				nub.style.borderColor = `${color}99`;
			}

			const resetText = resetMs ? ` · ${formatResetCountdown(resetMs)}` : '';
			labelEl.textContent = `${prefix}${resetText}`;
		}

		setUsage(usage) {
			this.refreshProgressChrome();
			const session = usage?.five_hour || null;
			const weekly = usage?.seven_day || null;
			const hasAnyUsage =
				!!(session && typeof session.utilization === 'number') || !!(weekly && typeof weekly.utilization === 'number');
			this.usageLine?.classList.toggle('cc-hidden', !hasAnyUsage);

			if (session && typeof session.utilization === 'number') {
				this.sessionResetMs = session.resets_at ? Date.parse(session.resets_at) : null;
				this.sessionWindowStartMs = this.sessionResetMs ? this.sessionResetMs - 5 * 60 * 60 * 1000 : null;
				this._applyBattery(this._sessionBat, session.utilization, this.sessionUsageSpan, this.sessionResetMs, 'Session');
			} else {
				this.sessionResetMs = null;
				this.sessionWindowStartMs = null;
				this._applyBattery(this._sessionBat, 0, this.sessionUsageSpan, null, 'Session');
			}

			const hasWeekly = weekly && typeof weekly.utilization === 'number';
			const divider = this.usageLine?.querySelector('[style*="1px"]');
			if (divider) divider.classList.toggle('cc-hidden', !hasWeekly);
			this._weeklyBat.root.closest('.cc-batWrapper')?.classList.toggle('cc-hidden', !hasWeekly);

			if (hasWeekly) {
				this.weeklyResetMs = weekly.resets_at ? Date.parse(weekly.resets_at) : null;
				this.weeklyWindowStartMs = this.weeklyResetMs ? this.weeklyResetMs - 7 * 24 * 60 * 60 * 1000 : null;
				this._applyBattery(this._weeklyBat, weekly.utilization, this.weeklyUsageSpan, this.weeklyResetMs, 'Weekly');
			} else {
				this.weeklyResetMs = null;
				this.weeklyWindowStartMs = null;
			}
		}

		tick() {
			const now = Date.now();

			// Cache countdown
			if (this.lastCachedUntilMs && this.lastCachedUntilMs > now) {
				const secondsLeft = Math.max(0, Math.ceil((this.lastCachedUntilMs - now) / 1000));
				if (this.cacheTimeSpan) this.cacheTimeSpan.textContent = formatSeconds(secondsLeft);
			} else if (this.lastCachedUntilMs && this.lastCachedUntilMs <= now) {
				this.lastCachedUntilMs = null;
				this.cacheTimeSpan = null;
				this.pendingCache = false;
				this.cachedDisplay.textContent = '';
				this._renderHeader();
			}

			// Reset countdown in battery labels
			if (this.sessionResetMs && this.sessionUsageSpan?.textContent) {
				const idx = this.sessionUsageSpan.textContent.indexOf('· ');
				if (idx !== -1) {
					const prefix = this.sessionUsageSpan.textContent.slice(0, idx + '· '.length);
					this.sessionUsageSpan.textContent = `${prefix}${formatResetCountdown(this.sessionResetMs)}`;
				}
			}
			if (this.weeklyResetMs && this.weeklyUsageSpan?.textContent) {
				const idx = this.weeklyUsageSpan.textContent.indexOf('· ');
				if (idx !== -1) {
					const prefix = this.weeklyUsageSpan.textContent.slice(0, idx + '· '.length);
					this.weeklyUsageSpan.textContent = `${prefix}${formatResetCountdown(this.weeklyResetMs)}`;
				}
			}
		}
	}

	CC.ui = { CounterUI };
})();
