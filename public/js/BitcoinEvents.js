(() => {
  const state = {
    nearbyEvents: [],
    moreEvents: [],
    searchOrigin: null,
    radiusMiles: 25,
    showAllEvents: false,
    isLoading: false,
    hasSearched: false,
    hasLoadedAllEvents: false,
    errorMessage: '',
    zipCode: '',
  };

  const elements = {};

  function init() {
    elements.list = document.querySelector('[data-events-list]');
    elements.searchOrigin = document.querySelector('[data-search-origin]');
    elements.modeButtons = Array.from(document.querySelectorAll('[data-mode]'));
    elements.zipOpenButtons = Array.from(document.querySelectorAll('[data-zip-open]'));
    elements.zipCancelButtons = Array.from(document.querySelectorAll('[data-zip-cancel]'));
    elements.zipModal = document.querySelector('[data-zip-modal]');
    elements.zipForm = document.querySelector('[data-zip-form]');
    elements.zipInput = document.querySelector('[data-zip-input]');
    elements.zipError = document.querySelector('[data-zip-error]');
    elements.zipSubmit = document.querySelector('[data-zip-submit]');

    elements.modeButtons.forEach((button) => {
      button.addEventListener('click', () => {
        state.showAllEvents = button.dataset.mode === 'all';

        if (state.showAllEvents && !state.hasLoadedAllEvents && !state.isLoading) {
          loadAllEvents();
          return;
        }

        render();
      });
    });

    elements.zipOpenButtons.forEach((button) => {
      button.addEventListener('click', () => openZipModal());
    });

    elements.zipCancelButtons.forEach((button) => {
      button.addEventListener('click', () => closeZipModal());
    });

    elements.zipInput?.addEventListener('input', () => {
      elements.zipInput.value = formatZipEntry(elements.zipInput.value);
      setZipError('');
    });

    elements.zipForm?.addEventListener('submit', (event) => {
      event.preventDefault();
      submitZipCode();
    });

    render();
    openZipModal();
  }

  async function loadAllEvents() {
    state.isLoading = true;
    state.errorMessage = '';
    render();

    try {
      const response = await fetchEvents();
      applyEventsResponse(response);
      state.showAllEvents = true;
      state.hasLoadedAllEvents = true;
    } catch (error) {
      state.errorMessage = userFacingErrorMessage(error);
    } finally {
      state.isLoading = false;
      render();
    }
  }

  async function submitZipCode() {
    const normalizedZip = normalizedPostalCode(elements.zipInput?.value || '');

    if (!isValidPostalCode(normalizedZip)) {
      setZipError('Enter a valid ZIP code.');
      return;
    }

    state.zipCode = normalizedZip;
    setZipError('');
    setZipSubmitting(true);

    try {
      const response = await fetchEvents({ postalCode: normalizedZip });
      applyEventsResponse(response);
      state.showAllEvents = false;
      state.hasSearched = true;
      state.hasLoadedAllEvents = true;
      closeZipModal();
    } catch (error) {
      setZipError(userFacingErrorMessage(error));
    } finally {
      setZipSubmitting(false);
      render();
    }
  }

  async function fetchEvents(params = {}) {
    const url = new URL('/v1/bitcoin-events', window.location.origin);

    if (params.postalCode) {
      url.searchParams.set('postalCode', params.postalCode);
    }

    const response = await fetch(url.toString(), {
      headers: {
        Accept: 'application/json',
      },
    });
    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(body.message || body.error || 'events_unavailable');
    }

    return body;
  }

  function applyEventsResponse(response) {
    state.nearbyEvents = Array.isArray(response.nearbyEvents) ? response.nearbyEvents : [];
    state.moreEvents = Array.isArray(response.moreEvents) ? response.moreEvents : [];
    state.searchOrigin = response.searchOrigin || null;
    state.radiusMiles = Number(response.radiusMiles) || 25;
    state.errorMessage = '';

    if (state.searchOrigin?.source === 'postalCode' && state.searchOrigin.postalCode) {
      state.zipCode = state.searchOrigin.postalCode;
      if (elements.zipInput) {
        elements.zipInput.value = state.zipCode;
      }
    }
  }

  function render() {
    renderModeToggle();
    renderSearchOrigin();
    renderEventsList();

    if (window.lucide) {
      window.lucide.createIcons({
        attrs: {
          width: 18,
          height: 18,
          stroke: 'currentColor',
          'stroke-width': 2,
        },
      });
    }
  }

  function renderModeToggle() {
    elements.modeButtons?.forEach((button) => {
      const isActive = state.showAllEvents === (button.dataset.mode === 'all');
      button.classList.toggle('is-active', isActive);
      button.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
  }

  function renderSearchOrigin() {
    if (!elements.searchOrigin) {
      return;
    }

    const text = searchOriginText();
    elements.searchOrigin.hidden = !text;
    elements.searchOrigin.textContent = text;
  }

  function renderEventsList() {
    if (!elements.list) {
      return;
    }

    const visibleEvents = getVisibleEvents();

    if (state.isLoading && visibleEvents.length === 0) {
      elements.list.innerHTML = loadingCardHtml();
      return;
    }

    if (state.errorMessage && visibleEvents.length === 0) {
      elements.list.innerHTML = stateCardHtml({
        title: 'Events unavailable',
        message: state.errorMessage,
        isError: true,
      });
      bindStateCardActions();
      return;
    }

    if (!state.hasSearched && !state.showAllEvents) {
      elements.list.innerHTML = stateCardHtml({
        title: 'Enter a ZIP code to find nearby Bitcoin events.',
        message: `We will show events within ${state.radiusMiles} miles.`,
        isError: false,
      });
      bindStateCardActions();
      return;
    }

    if (visibleEvents.length === 0) {
      elements.list.innerHTML = stateCardHtml({
        title: state.showAllEvents ? 'No events listed yet' : 'No nearby events yet',
        message: state.showAllEvents
          ? 'We do not have any upcoming Bitcoin events across the US yet.'
          : `We could not find any Bitcoin events within ${state.radiusMiles} miles of this area.`,
        isError: false,
      });
      bindStateCardActions();
      return;
    }

    elements.list.innerHTML = visibleEvents.map(eventCardHtml).join('');
  }

  function bindStateCardActions() {
    elements.list?.querySelector('[data-state-zip]')?.addEventListener('click', () => openZipModal());
  }

  function loadingCardHtml() {
    return `
      <article class="state-card">
        <div class="state-card__spinner" aria-hidden="true"></div>
        <h2>Looking for nearby Bitcoin events...</h2>
      </article>
    `;
  }

  function stateCardHtml({ title, message }) {
    return `
      <article class="state-card">
        <h2>${escapeHtml(title)}</h2>
        <p>${escapeHtml(message)}</p>
        <button class="state-card__button" type="button" data-state-zip>Enter ZIP Code</button>
      </article>
    `;
  }

  function eventCardHtml(event) {
    const coverHtml = event.coverImageUrl
      ? `<img src="${escapeAttribute(event.coverImageUrl)}" alt="" loading="lazy" />`
      : `<div class="event-card__fallback"><i data-lucide="calendar-clock"></i></div>`;
    const hostName = cleanText(event.hostName);
    const hostHtml = hostName
      ? metaRowHtml('users', hostName)
      : '';

    return `
      <a class="event-card" href="${escapeAttribute(safeEventUrl(event.sourceUrl))}" target="_blank" rel="noopener">
        <div class="event-card__cover">
          ${coverHtml}
          <span class="event-card__distance">${escapeHtml(distanceText(event.distanceMiles))}</span>
        </div>

        <div class="event-card__body">
          <h2 class="event-card__title">${escapeHtml(cleanText(event.title) || 'Bitcoin Event')}</h2>

          <div class="event-meta">
            ${metaRowHtml('calendar', formatEventDate(event.startsAt, event.timezone))}
            ${metaRowHtml('map-pin', locationLine(event))}
            ${hostHtml}
          </div>
        </div>
      </a>
    `;
  }

  function metaRowHtml(icon, text) {
    return `
      <div class="event-meta__row">
        <i data-lucide="${escapeAttribute(icon)}"></i>
        <span>${escapeHtml(text)}</span>
      </div>
    `;
  }

  function getVisibleEvents() {
    const events = state.showAllEvents
      ? dedupeEvents([...state.nearbyEvents, ...state.moreEvents])
      : state.nearbyEvents;

    return events.slice().sort((left, right) => {
      const leftTime = Date.parse(left.startsAt) || Number.MAX_SAFE_INTEGER;
      const rightTime = Date.parse(right.startsAt) || Number.MAX_SAFE_INTEGER;
      return leftTime - rightTime;
    });
  }

  function dedupeEvents(events) {
    const seen = new Set();
    return events.filter((event) => {
      const id = cleanText(event.id || event.externalEventId || event.sourceUrl);
      if (!id || seen.has(id)) {
        return false;
      }
      seen.add(id);
      return true;
    });
  }

  function searchOriginText() {
    if (state.searchOrigin?.source === 'postalCode' && state.searchOrigin.postalCode) {
      return `Showing events within ${state.radiusMiles} miles of ${state.searchOrigin.postalCode}.`;
    }

    if (state.showAllEvents) {
      return 'Showing upcoming Bitcoin events across the United States.';
    }

    return '';
  }

  function openZipModal() {
    if (!elements.zipModal) {
      return;
    }

    elements.zipModal.hidden = false;
    document.body.style.overflow = 'hidden';

    if (elements.zipInput) {
      elements.zipInput.value = state.zipCode || '';
      window.setTimeout(() => elements.zipInput.focus(), 120);
    }
  }

  function closeZipModal() {
    if (!elements.zipModal) {
      return;
    }

    elements.zipModal.hidden = true;
    document.body.style.overflow = '';
    setZipError('');
  }

  function setZipError(message) {
    if (!elements.zipError) {
      return;
    }

    elements.zipError.hidden = !message;
    elements.zipError.textContent = message;
  }

  function setZipSubmitting(isSubmitting) {
    if (elements.zipSubmit) {
      elements.zipSubmit.disabled = isSubmitting;
      elements.zipSubmit.textContent = isSubmitting ? 'Loading...' : 'Show Events';
    }
  }

  function normalizedPostalCode(value) {
    const digits = String(value || '').replace(/\D/g, '');

    if (digits.length > 5) {
      const prefix = digits.slice(0, 5);
      const suffix = digits.slice(5, 9);
      return suffix ? `${prefix}-${suffix}` : prefix;
    }

    return digits.slice(0, 5);
  }

  function formatZipEntry(value) {
    return normalizedPostalCode(value);
  }

  function isValidPostalCode(value) {
    const digits = String(value || '').replace(/\D/g, '');
    return digits.length === 5 || digits.length === 9;
  }

  function userFacingErrorMessage(error) {
    const raw = String(error?.message || '');

    if (
      raw.includes('That ZIP code')
      || raw.includes('We could not')
      || raw.includes('Enter a valid US ZIP code')
    ) {
      return raw;
    }

    return 'We could not load nearby Bitcoin events right now.';
  }

  function formatEventDate(startsAt, timezone) {
    const date = new Date(startsAt);

    if (Number.isNaN(date.getTime())) {
      return 'Date coming soon';
    }

    const options = {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    };

    if (timezone) {
      options.timeZone = timezone;
      options.timeZoneName = 'short';
    }

    try {
      return new Intl.DateTimeFormat('en-US', options).format(date);
    } catch (_error) {
      delete options.timeZone;
      delete options.timeZoneName;
      return new Intl.DateTimeFormat('en-US', options).format(date);
    }
  }

  function locationLine(event) {
    const venue = cleanText(event.venueName);
    const cityState = [event.city, event.region]
      .map(cleanText)
      .filter(Boolean)
      .join(', ');

    if (venue && cityState) {
      return `${venue} - ${cityState}`;
    }

    return venue || cityState || 'Location coming soon';
  }

  function distanceText(distanceMiles) {
    const distance = Number(distanceMiles);

    if (!Number.isFinite(distance)) {
      return 'Nearby';
    }

    if (distance < 0.1) {
      return 'Near you';
    }

    const rounded = distance >= 10
      ? Math.round(distance)
      : Math.round(distance * 10) / 10;

    return `${rounded} mi`;
  }

  function safeEventUrl(value) {
    try {
      const url = new URL(value);
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        return url.toString();
      }
    } catch (_error) {
      return '#';
    }

    return '#';
  }

  function cleanText(value) {
    return String(value || '').trim();
  }

  function escapeHtml(value) {
    return cleanText(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escapeAttribute(value) {
    return escapeHtml(value);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
