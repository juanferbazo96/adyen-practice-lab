(function () {
  "use strict";

  const DEFAULT_ADYEN_WEB_VERSION = "6.36.0";
  const DEFAULT_ADYEN_WEB_DOCS_VERSION = "6.36.0";
  const ADYEN_WEB_INTEGRATION = "Drop-in";
  const ADYEN_WEB_PLATFORM = "Web";
  const BACKEND_API_BASE_URL = "https://7u12rfue70.execute-api.eu-north-1.amazonaws.com";
  const STORAGE_KEY = "adyen-practice-lab-state-v2";
  const SUPPORTED_ADYEN_WEB_VERSIONS = ["6.36.0", "6.35.0", "6.34.0"];
  const DEFAULT_REFERENCE = "adyen-practice-test-001";

  const form = document.getElementById("paymentForm");
  const latestTraceBlocks = document.getElementById("latestTraceBlocks");
  const diagnosticTraceBlocks = document.getElementById("diagnosticTraceBlocks");
  const traceList = document.getElementById("traceList");
  const timeline = document.getElementById("timeline");
  const drawer = document.getElementById("traceDrawer");
  const scrim = document.getElementById("scrim");
  const dropinPanel = document.getElementById("dropinPanel");
  const dropinMount = document.getElementById("dropinMount");
  const dropinResult = document.getElementById("dropinResult");
  const paymentMethodToggles = document.getElementById("paymentMethodToggles");
  const paymentMethodWarnings = document.getElementById("paymentMethodWarnings");
  const versionPanel = document.getElementById("versionPanel");
  const warningList = document.getElementById("warningList");
  const payloadWarnings = document.getElementById("payloadWarnings");
  const docLinks = document.getElementById("docLinks");
  const modeExplainer = document.getElementById("modeExplainer");
  const manualParameterFields = document.getElementById("manualParameterFields");
  const manualOnly = Array.from(document.querySelectorAll(".manual-only"));
  const manualFieldState = {};

  const state = {
    traces: [],
    paymentMethods: [],
    selectedPaymentMethods: new Set(),
    webhookPollTimer: null,
    backendConfig: null,
    adyenWebLoadedVersion: null,
    adyenWebCssVersion: null,
    adyenSdkStatus: "not_loaded",
    lastTimeline: []
  };

  function byId(id) {
    return document.getElementById(id);
  }

  function fieldValue(id) {
    const field = byId(id);
    return field ? String(field.value || "").trim() : "";
  }

  function checked(id) {
    const field = byId(id);
    return Boolean(field && field.checked);
  }

  function selectedRadio(name, fallback) {
    const selected = document.querySelector(`input[name="${name}"]:checked`);
    return selected ? selected.value : fallback;
  }

  function selectedMode() {
    return selectedRadio("mode", "mock");
  }

  function selectedFlow() {
    return selectedRadio("flow", "sessions-dropin");
  }

  function selectedWebVersion() {
    const version = fieldValue("adyenWebVersion") || DEFAULT_ADYEN_WEB_VERSION;
    return SUPPORTED_ADYEN_WEB_VERSIONS.includes(version) ? version : DEFAULT_ADYEN_WEB_VERSION;
  }

  function selectedDocsVersion() {
    const version = fieldValue("adyenDocsVersion") || DEFAULT_ADYEN_WEB_DOCS_VERSION;
    return SUPPORTED_ADYEN_WEB_VERSIONS.includes(version) ? version : DEFAULT_ADYEN_WEB_DOCS_VERSION;
  }

  function backendBaseUrl() {
    return (fieldValue("backendUrl") || BACKEND_API_BASE_URL).replace(/\/+$/, "");
  }

  function checkoutApiVersion() {
    return fieldValue("checkoutApiVersion") || state.backendConfig?.checkoutApiVersion || "v71";
  }

  function adyenWebJsUrl(version) {
    return `https://checkoutshopper-test.adyen.com/checkoutshopper/sdk/${version}/adyen.js`;
  }

  function adyenWebCssUrl(version) {
    return `https://checkoutshopper-test.adyen.com/checkoutshopper/sdk/${version}/adyen.css`;
  }

  function docsUrl(flow) {
    const query = `platform=${encodeURIComponent(ADYEN_WEB_PLATFORM)}&integration=${encodeURIComponent(ADYEN_WEB_INTEGRATION)}&version=${encodeURIComponent(selectedDocsVersion())}`;
    if (flow === "advanced") return `https://docs.adyen.com/online-payments/build-your-integration/advanced-flow?${query}`;
    if (flow === "best-practices") return "https://docs.adyen.com/online-payments/web-best-practices/";
    return `https://docs.adyen.com/online-payments/build-your-integration/sessions-flow?${query}`;
  }

  function metadata() {
    return {
      flow: selectedFlow(),
      adyenWebVersion: selectedWebVersion(),
      adyenWebDocsVersion: selectedDocsVersion(),
      adyenWebLoadedVersion: state.adyenWebLoadedVersion,
      checkoutApiVersion: checkoutApiVersion(),
      checkoutApiBaseUrl: state.backendConfig?.checkoutApiBaseUrl || state.backendConfig?.checkoutBaseUrl || null,
      backendApiBaseUrl: backendBaseUrl()
    };
  }

  function parseJsonField(id) {
    const raw = fieldValue(id);
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
      throw new Error(`${id} must contain valid JSON: ${error.message}`);
    }
  }

  function amountObject() {
    return {
      currency: fieldValue("currency") || "EUR",
      value: Number.parseInt(fieldValue("amount") || "0", 10)
    };
  }

  function referenceValue() {
    const reference = fieldValue("reference");
    if (!reference || reference === DEFAULT_REFERENCE) return `adyen-practice-test-${Date.now()}`;
    return reference;
  }

  function currentOperation() {
    if (selectedFlow() === "sessions-dropin") return "sessions";
    if (selectedFlow() === "advanced-dropin") return "advancedDropin";
    return fieldValue("operation") || "payments";
  }

  function selectedPaymentMethodTypes() {
    return Array.from(state.selectedPaymentMethods);
  }

  function setPaymentMethodWarnings(messages) {
    if (!paymentMethodWarnings) return;
    paymentMethodWarnings.innerHTML = "";
    messages.forEach((message) => {
      const item = document.createElement("p");
      item.className = "warning";
      item.textContent = message;
      paymentMethodWarnings.append(item);
    });
  }

  function paymentMethodName(method) {
    return method?.name || method?.brand || method?.type || "payment method";
  }

  function flattenPaymentMethods(responseBody) {
    const body = responseBody?.adyen || responseBody || {};
    const groups = [];
    if (Array.isArray(body.paymentMethods)) groups.push(...body.paymentMethods);
    if (Array.isArray(body.storedPaymentMethods)) groups.push(...body.storedPaymentMethods);
    return groups
      .map((method) => ({
        type: method.type,
        name: paymentMethodName(method),
        raw: method
      }))
      .filter((method) => method.type);
  }

  function renderPaymentMethodToggles() {
    if (!paymentMethodToggles) return;
    paymentMethodToggles.innerHTML = "";
    if (!state.paymentMethods.length) {
      const empty = document.createElement("p");
      empty.className = "method-empty";
      empty.textContent = "Run /paymentMethods to populate available methods.";
      paymentMethodToggles.append(empty);
      return;
    }
    state.paymentMethods.forEach((method) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `method-chip${state.selectedPaymentMethods.has(method.type) ? " is-selected" : ""}`;
      button.dataset.method = method.type;
      button.textContent = method.name;
      button.addEventListener("click", () => {
        if (state.selectedPaymentMethods.has(method.type)) state.selectedPaymentMethods.delete(method.type);
        else state.selectedPaymentMethods.add(method.type);
        if (!state.selectedPaymentMethods.size) state.selectedPaymentMethods.add(method.type);
        renderPaymentMethodToggles();
        persistState();
      });
      paymentMethodToggles.append(button);
    });
  }

  function addTimelineStep(label, detail) {
    state.lastTimeline.push({
      time: new Date().toISOString(),
      label,
      detail: detail || null
    });
    renderTimeline();
  }

  function renderTimeline() {
    timeline.innerHTML = "";
    const heading = document.createElement("h3");
    heading.textContent = "Integration Microscope";
    timeline.append(heading);
    const list = document.createElement("ol");
    state.lastTimeline.forEach((step) => {
      const item = document.createElement("li");
      item.textContent = step.detail ? `${step.label}: ${step.detail}` : step.label;
      list.append(item);
    });
    timeline.append(list);
  }

  function setWarnings(messages) {
    warningList.innerHTML = "";
    messages.forEach((message) => {
      const item = document.createElement("p");
      item.className = "warning";
      item.textContent = message;
      warningList.append(item);
    });
  }

  function setPayloadWarnings(messages) {
    payloadWarnings.innerHTML = "";
    messages.forEach((message) => {
      const item = document.createElement("p");
      item.className = "warning";
      item.textContent = message;
      payloadWarnings.append(item);
    });
  }

  function merchantAccount() {
    return fieldValue("merchantAccount") || "VerihopECOM";
  }

  function csvValues(id) {
    return fieldValue(id)
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function granularFields(target) {
    const fields = {};
    const warnings = [];
    const isSessions = target === "sessions";
    if (checked("storePaymentMethod")) fields.storePaymentMethod = true;
    if (checked("installments") && !isSessions) fields.installments = { value: 3 };
    if (checked("installments") && isSessions) warnings.push("Installments are skipped for /sessions in this lab; inspect them in Advanced or Manual /payments.");
    if (checked("metadata")) {
      fields.metadata = {
        surface: "adyen-practice-lab",
        integrationFlow: selectedFlow(),
        disposable: "true"
      };
    }
    if (checked("lineItems")) {
      const amount = amountObject();
      fields.lineItems = [
        {
          id: "adyen-lab-1",
          description: "Implementation engineer practice payment",
          amountExcludingTax: amount.value,
          amountIncludingTax: amount.value,
          quantity: 1,
          taxAmount: 0,
          taxPercentage: 0
        }
      ];
    }
    if (checked("splitPayment")) {
      if (target === "sessions") {
        warnings.push("Split instructions are not added to /sessions in this lab; use Manual /payments to inspect split payload shape.");
      } else {
        const amount = amountObject();
        fields.splits = {
          type: "MarketPay",
          totalAmount: amount.value,
          currencyCode: amount.currency,
          splits: [
            { amount: Math.max(0, amount.value - 100), type: "MarketPlace", account: "PracticeSellerAccount", reference: "split-practice-seller" },
            { amount: Math.min(100, amount.value), type: "Commission", reference: "split-practice-commission" }
          ]
        };
      }
    }
    const additionalData = parseJsonField("additionalData");
    if (Object.keys(additionalData).length) fields.additionalData = additionalData;
    if (checked("threeDS2") && target === "payments") {
      fields.authenticationData = {
        threeDSRequestData: {
          nativeThreeDS: "preferred",
          threeDSRequestorChallengeInd: "03"
        }
      };
      fields.browserInfo = {
        userAgent: navigator.userAgent,
        acceptHeader: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      };
    }
    setPayloadWarnings(warnings);
    return fields;
  }

  function paymentMethodPayload() {
    const type = selectedPaymentMethodTypes()[0] || "ideal";
    if (type === "ideal") return { type, issuer: "1121" };
    if (type === "paypal" || type === "klarna" || type === "applepay" || type === "googlepay") return { type };
    return {
      type: "scheme",
      encryptedCardNumber: "test_4111111111111111",
      encryptedExpiryMonth: "test_03",
      encryptedExpiryYear: "test_2030",
      encryptedSecurityCode: "test_737",
      holderName: "Adyen Practice Shopper"
    };
  }

  function manualPaymentMethodPayload() {
    const type = manualFieldValue("manualPaymentMethodType", "ideal") || "ideal";
    if (type === "ideal") return { type, issuer: manualFieldValue("manualIssuer", "1121") || "1121" };
    if (type === "scheme") {
      setPayloadWarnings(["Manual card payments need real Adyen Web encrypted fields. Use Sessions or Advanced Drop-in for card practice."]);
      return { type: "scheme" };
    }
    return { type };
  }

  function selectedNonCardPaymentMethodPayload() {
    const type = selectedPaymentMethodTypes().find((methodType) => methodType && methodType !== "scheme");
    if (!type) return null;
    if (type === "ideal") return { type, issuer: "1121" };
    return { type };
  }

  function hasUsablePaymentMethod(paymentMethod) {
    return Boolean(paymentMethod && typeof paymentMethod === "object" && paymentMethod.type);
  }

  function ensurePaymentMethodForRequest(request) {
    if (request.endpoint !== "/payments") return request.payload;
    if (hasUsablePaymentMethod(request.payload?.paymentMethod)) return request.payload;

    const fallback =
      selectedNonCardPaymentMethodPayload() ||
      (selectedFlow() === "manual-api" ? manualPaymentMethodPayload() : null);
    if (hasUsablePaymentMethod(fallback)) {
      addTimelineStep("frontend: repaired missing paymentMethod", fallback.type);
      request.payload = { ...request.payload, paymentMethod: fallback };
      return request.payload;
    }

    const message = "Payment method is missing. Select a non-card fetched payment method, or use Card through the rendered Drop-in fields.";
    addTimelineStep("frontend: blocked invalid /payments payload", "paymentMethod missing");
    throw new Error(message);
  }

  function basePaymentFields(target) {
    const fields = {
      merchantAccount: merchantAccount(),
      amount: amountObject(),
      reference: referenceValue(),
      countryCode: fieldValue("countryCode") || "NL",
      shopperEmail: fieldValue("shopperEmail"),
      shopperReference: fieldValue("shopperReference"),
      shopperInteraction: fieldValue("shopperInteraction") || "Ecommerce",
      returnUrl: fieldValue("returnUrl"),
      channel: "Web",
      ...granularFields(target)
    };
    const captureDelayHours = fieldValue("captureDelayHours");
    if (captureDelayHours !== "" && captureDelayHours !== "manual" && target !== "sessions") {
      fields.captureDelayHours = Number(captureDelayHours);
    }
    return fields;
  }

  function sessionPayload(extra = {}) {
    const base = basePaymentFields("sessions");
    const payload = {
      merchantAccount: base.merchantAccount,
      amount: base.amount,
      reference: base.reference,
      countryCode: base.countryCode,
      shopperEmail: base.shopperEmail,
      shopperReference: base.shopperReference,
      shopperInteraction: base.shopperInteraction,
      returnUrl: base.returnUrl,
      channel: base.channel,
      ...extra
    };
    ["lineItems", "metadata", "additionalData", "storePaymentMethod"].forEach((key) => {
      if (base[key] !== undefined) payload[key] = base[key];
    });
    return payload;
  }

  const manualOperationFields = {
    paymentMethods: [
      { id: "manualShopperLocale", label: "Shopper locale", value: "en-US" },
      { id: "manualAllowedPaymentMethods", label: "Allowed payment methods CSV", value: "" },
      { id: "manualBlockedPaymentMethods", label: "Blocked payment methods CSV", value: "" }
    ],
    sessions: [
      { id: "manualShopperLocale", label: "Shopper locale", value: "en-US" },
      { id: "manualAllowedPaymentMethods", label: "Allowed payment methods CSV", value: "" },
      { id: "manualBlockedPaymentMethods", label: "Blocked payment methods CSV", value: "" }
    ],
    payments: [
      {
        id: "manualPaymentMethodType",
        label: "Payment method",
        value: "ideal",
        options: [
          ["ideal", "iDEAL"],
          ["scheme", "Card - requires encrypted fields"],
          ["paypal", "PayPal"],
          ["klarna", "Klarna"]
        ]
      },
      { id: "manualIssuer", label: "Issuer", value: "1121" },
      { id: "manualShopperIP", label: "Shopper IP", value: "" },
      { id: "manualBillingStreet", label: "Billing street", value: "" },
      { id: "manualBillingCity", label: "Billing city", value: "" },
      { id: "manualBillingCountry", label: "Billing country", value: "NL" },
      { id: "manualBillingPostalCode", label: "Billing postal code", value: "" }
    ],
    details: [
      { id: "manualRedirectResult", label: "redirectResult", value: "test-redirect-result" },
      { id: "manualPaymentData", label: "paymentData", value: "test-payment-data" }
    ],
    capture: [
      { id: "manualPspReference", label: "PSP reference", value: "test-psp-reference" },
      { id: "manualModificationReference", label: "Modification reference", value: "manual-capture" }
    ],
    cancel: [
      { id: "manualPspReference", label: "PSP reference", value: "test-psp-reference" },
      { id: "manualModificationReference", label: "Modification reference", value: "manual-cancel" }
    ],
    refund: [
      { id: "manualPspReference", label: "PSP reference", value: "test-psp-reference" },
      { id: "manualModificationReference", label: "Modification reference", value: "manual-refund" }
    ]
  };

  function manualFieldValue(id, fallback = "") {
    const field = byId(id);
    return field ? String(field.value || "").trim() : fallback;
  }

  function applyPaymentMethodExtras(payload) {
    const allowedPaymentMethods = csvValues("manualAllowedPaymentMethods");
    const blockedPaymentMethods = csvValues("manualBlockedPaymentMethods");
    const shopperLocale = manualFieldValue("manualShopperLocale");
    if (shopperLocale) payload.shopperLocale = shopperLocale;
    if (allowedPaymentMethods.length) payload.allowedPaymentMethods = allowedPaymentMethods;
    if (blockedPaymentMethods.length) payload.blockedPaymentMethods = blockedPaymentMethods;
    return payload;
  }

  function applyManualPaymentExtras(payload) {
    const shopperIP = manualFieldValue("manualShopperIP");
    if (shopperIP) payload.shopperIP = shopperIP;
    const billingAddress = {
      street: manualFieldValue("manualBillingStreet"),
      city: manualFieldValue("manualBillingCity"),
      country: manualFieldValue("manualBillingCountry"),
      postalCode: manualFieldValue("manualBillingPostalCode")
    };
    if (billingAddress.street || billingAddress.city || billingAddress.postalCode) payload.billingAddress = billingAddress;
    return payload;
  }

  function manualRequest() {
    const operation = fieldValue("operation") || "payments";
    if (operation === "paymentMethods") {
      return {
        endpoint: "/payment-methods",
        adyenEndpoint: "/paymentMethods",
        payload: {
          merchantAccount: merchantAccount(),
          amount: amountObject(),
          countryCode: fieldValue("countryCode") || "NL",
          channel: "Web",
          ...applyPaymentMethodExtras(granularFields("paymentMethods"))
        }
      };
    }
    if (operation === "sessions") {
      return { endpoint: "/sessions", adyenEndpoint: "/sessions", payload: applyPaymentMethodExtras(sessionPayload()) };
    }
    if (operation === "details") {
      return {
        endpoint: "/payments/details",
        adyenEndpoint: "/payments/details",
        payload: { details: { redirectResult: manualFieldValue("manualRedirectResult", "test-redirect-result") }, paymentData: manualFieldValue("manualPaymentData", "test-payment-data") }
      };
    }
    if (operation === "capture" || operation === "cancel" || operation === "refund") {
      const endpoint = `/payments/${encodeURIComponent(manualFieldValue("manualPspReference", "test-psp-reference"))}/${operation}s`;
      return {
        endpoint,
        adyenEndpoint: endpoint,
        payload: {
          merchantAccount: merchantAccount(),
          amount: amountObject(),
          reference: manualFieldValue("manualModificationReference", `${referenceValue()}-${operation}`)
        }
      };
    }
    return {
      endpoint: "/payments",
      adyenEndpoint: "/payments",
      payload: applyManualPaymentExtras({ ...basePaymentFields("payments"), paymentMethod: manualPaymentMethodPayload() })
    };
  }

  function buildOperationRequest() {
    if (selectedFlow() === "sessions-dropin") {
      const selectedMethods = selectedPaymentMethodTypes();
      return {
        endpoint: "/sessions",
        adyenEndpoint: "/sessions",
        callback: "beforeSubmit",
        payload: sessionPayload(selectedMethods.length ? { allowedPaymentMethods: selectedMethods } : {})
      };
    }
    if (selectedFlow() === "advanced-dropin") {
      return {
        endpoint: "/payment-methods",
        adyenEndpoint: "/paymentMethods",
        callback: "createPaymentMethods",
        payload: {
          merchantAccount: merchantAccount(),
          amount: amountObject(),
          countryCode: fieldValue("countryCode") || "NL",
          shopperLocale: "en-US",
          channel: "Web"
        }
      };
    }
    return manualRequest();
  }

  function idempotencyKeyFor(request) {
    const reference = request?.payload?.reference || fieldValue("reference") || "adyen-practice-test";
    return `${selectedFlow()}-${reference}`.replace(/[^a-zA-Z0-9_.:-]/g, "-").slice(0, 80);
  }

  async function parseFetchResponse(response) {
    const text = await response.text();
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return text;
    }
  }

  async function callBackend(request, options = {}) {
    const url = `${backendBaseUrl()}${request.endpoint}`;
    const payload = ensurePaymentMethodForRequest(request);
    const headers = {
      "content-type": "application/json",
      "x-requested-with": "adyen-practice-lab",
      "x-adyen-checkout-version": checkoutApiVersion()
    };
    if (request.endpoint === "/payments" || request.endpoint === "/sessions") {
      headers["idempotency-key"] = options.idempotencyKey || idempotencyKeyFor(request);
    }
    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload)
      });
    } catch (error) {
      throw new Error(`Backend request failed. Check CORS/network for ${url}. Browser said: ${error.message}`);
    }
    return {
      status: response.status,
      ok: response.ok,
      headers: {
        idempotencyKey: headers["idempotency-key"] || null
      },
      body: await parseFetchResponse(response)
    };
  }

  async function getBackend(path) {
    const response = await fetch(`${backendBaseUrl()}${path}`, {
      method: "GET",
      headers: {
        "x-requested-with": "adyen-practice-lab",
        "x-adyen-checkout-version": checkoutApiVersion()
      }
    });
    return {
      status: response.status,
      ok: response.ok,
      body: await parseFetchResponse(response)
    };
  }

  async function postBackend(path, payload) {
    const response = await fetch(`${backendBaseUrl()}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-requested-with": "adyen-practice-lab",
        "x-adyen-checkout-version": checkoutApiVersion()
      },
      body: JSON.stringify(payload)
    });
    return {
      status: response.status,
      ok: response.ok,
      body: await parseFetchResponse(response)
    };
  }

  async function ensureConfig() {
    try {
      const result = await getBackend("/config");
      if (result.ok && result.body) state.backendConfig = result.body;
      if (Array.isArray(result.body?.supportedCheckoutApiVersions)) {
        const select = byId("checkoutApiVersion");
        if (select) {
          Array.from(select.options).forEach((option) => {
            option.disabled = !result.body.supportedCheckoutApiVersions.includes(option.value);
          });
        }
      }
      renderVersionPanel();
      return result;
    } catch (error) {
      renderVersionPanel([`Could not load backend config; frontend version only. ${error.message}`]);
      return { status: "error", ok: false, body: { error: error.message } };
    }
  }

  function filterPaymentMethodsResponse(responseBody) {
    const body = JSON.parse(JSON.stringify(responseBody?.adyen || responseBody || {}));
    const selected = selectedPaymentMethodTypes();
    if (!selected.length) return body;
    if (Array.isArray(body.paymentMethods)) {
      body.paymentMethods = body.paymentMethods.filter((method) => selected.includes(method.type));
    }
    if (Array.isArray(body.storedPaymentMethods)) {
      body.storedPaymentMethods = body.storedPaymentMethods.filter((method) => selected.includes(method.type));
    }
    return body;
  }

  async function loadPaymentMethods(options = {}) {
    await ensureConfig();
    const request = {
      endpoint: "/payment-methods",
      adyenEndpoint: "/paymentMethods",
      callback: "loadPaymentMethods",
      payload: {
        merchantAccount: merchantAccount(),
        amount: amountObject(),
        countryCode: fieldValue("countryCode") || "NL",
        shopperLocale: "en-US",
        channel: "Web"
      }
    };
    if (selectedMode() !== "backend") {
      const body = mockResponse(request);
      state.paymentMethods = flattenPaymentMethods(body);
      if (!state.selectedPaymentMethods.size) {
        state.selectedPaymentMethods = new Set(state.paymentMethods.map((method) => method.type));
      }
      renderPaymentMethodToggles();
      setPaymentMethodWarnings([]);
      return { status: "mock", ok: true, body };
    }
    const response = await callBackend(request);
    if (response.ok) {
      state.paymentMethods = flattenPaymentMethods(response.body);
      if (!state.selectedPaymentMethods.size) {
        state.selectedPaymentMethods = new Set(state.paymentMethods.map((method) => method.type));
      }
      renderPaymentMethodToggles();
      setPaymentMethodWarnings(state.paymentMethods.length ? [] : ["Adyen returned no payment methods for the current amount, currency, country, and merchant account."]);
    } else {
      setPaymentMethodWarnings([`/paymentMethods failed with status ${response.status}. See the latest response panel for details.`]);
    }
    if (options.trace) {
      addTrace({
        time: new Date().toISOString(),
        mode: selectedMode(),
        flow: selectedFlow(),
        operation: "paymentMethods",
        metadata: metadata(),
        idempotencyKey: null,
        request,
        response,
        webhook: null
      });
    }
    return response;
  }

  function sdkUrlsForSelectedVersion() {
    const version = selectedWebVersion();
    return {
      js: adyenWebJsUrl(version),
      css: adyenWebCssUrl(version)
    };
  }

  async function loadAdyenSdk() {
    const version = selectedWebVersion();
    if (state.adyenWebLoadedVersion === version && (window.AdyenWeb?.AdyenCheckout || window.AdyenCheckout)) return true;
    const urls = sdkUrlsForSelectedVersion();
    state.adyenSdkStatus = "loading";
    addTimelineStep("frontend: Adyen Web version selected/loaded", version);

    let css = document.querySelector("link[data-adyen-web-css]");
    if (!css) {
      css = document.createElement("link");
      css.rel = "stylesheet";
      css.dataset.adyenWebCss = "true";
      document.head.append(css);
    }
    css.href = urls.css;
    state.adyenWebCssVersion = version;

    const oldScript = document.querySelector("script[data-adyen-web-js]");
    if (oldScript) oldScript.remove();
    return new Promise((resolve) => {
      const script = document.createElement("script");
      script.src = urls.js;
      script.async = true;
      script.dataset.adyenWebJs = "true";
      script.onload = () => {
        state.adyenWebLoadedVersion = version;
        state.adyenSdkStatus = "loaded";
        renderVersionPanel();
        resolve(true);
      };
      script.onerror = () => {
        state.adyenSdkStatus = "blocked_or_failed";
        renderVersionPanel(["Adyen Web SDK could not load. Check the browser console, network tab, and GitHub Pages CSP/browser extension settings; the backend payload lab still works."]);
        resolve(false);
      };
      document.head.append(script);
    });
  }

  function adyenCheckoutFactory() {
    return window.AdyenWeb?.AdyenCheckout || window.AdyenCheckout || null;
  }

  function dropinFactory() {
    return window.AdyenWeb?.Dropin || null;
  }

  async function createCheckout(config) {
    const factory = adyenCheckoutFactory();
    if (!factory) throw new Error("AdyenCheckout factory was not exposed by the SDK.");
    return factory(config);
  }

  function mountDropin(checkout, mountElement, dropinConfiguration = {}) {
    const Dropin = dropinFactory();
    if (Dropin) {
      return new Dropin(checkout, dropinConfiguration).mount(mountElement);
    }
    if (checkout?.create) {
      return checkout.create("dropin", dropinConfiguration).mount(mountElement);
    }
    throw new Error("Drop-in factory was not exposed by the SDK.");
  }

  async function mountSessionsDropin(sessionResponse) {
    dropinMount.innerHTML = "";
    const session = sessionResponse?.body?.adyen || sessionResponse?.body;
    if (!state.backendConfig?.clientKey || !session?.id || !session?.sessionData) {
      dropinMount.textContent = "Drop-in cannot mount until /sessions returns id and sessionData.";
      return;
    }
    const loaded = await loadAdyenSdk();
    if (!loaded || !adyenCheckoutFactory()) {
      dropinMount.innerHTML = "<strong>SDK not mounted</strong><span>Adyen Web could not load under this page policy. Request/response learning still works.</span>";
      return;
    }
    try {
      const checkout = await createCheckout({
        environment: "test",
        clientKey: state.backendConfig.clientKey,
        session,
        beforeSubmit: (data, component, actions) => {
          addTimelineStep("frontend: beforeSubmit fired", "Sessions Drop-in");
          if (actions?.resolve) {
            actions.resolve(data);
            addTimelineStep("frontend: beforeSubmit resolved", data?.paymentMethod?.type || "submitted data");
          }
        },
        onPaymentCompleted: (result) => {
          dropinResult.textContent = `Payment completed: ${result?.resultCode || "completed"}`;
          addTimelineStep("frontend: payment completed", result?.resultCode || "completed");
        },
        onPaymentFailed: (result) => {
          const reason = result?.refusalReason ? ` · ${result.refusalReason}` : "";
          const pspReference = result?.pspReference ? ` · ${result.pspReference}` : "";
          dropinResult.textContent = `Payment failed: ${result?.resultCode || "failed"}${reason}${pspReference}`;
          addTimelineStep("frontend: payment failed", result?.resultCode || "failed");
        },
        onError: (error) => {
          dropinResult.textContent = `Drop-in error: ${error?.message || error}`;
          addTimelineStep("frontend: Drop-in error", error?.message || String(error));
        }
      });
      mountDropin(checkout, dropinMount);
      addTimelineStep("frontend: Drop-in mounted", "Sessions flow");
    } catch (error) {
      dropinMount.textContent = `Drop-in mount failed: ${error.message}`;
    }
  }

  async function mountAdvancedDropin(paymentMethodsResponse) {
    dropinMount.innerHTML = "";
    const paymentMethodsResponseBody = filterPaymentMethodsResponse(paymentMethodsResponse?.body);
    const loaded = await loadAdyenSdk();
    if (!loaded || !adyenCheckoutFactory()) {
      dropinMount.innerHTML = "<strong>SDK not mounted</strong><span>Adyen Web could not load under this page policy. Advanced backend calls can still be inspected.</span>";
      return;
    }
    try {
      const checkout = await createCheckout({
        environment: "test",
        clientKey: state.backendConfig?.clientKey,
        countryCode: fieldValue("countryCode") || "NL",
        amount: amountObject(),
        paymentMethodsResponse: paymentMethodsResponseBody,
        onSubmit: async (stateData, component, actions) => {
          addTimelineStep("frontend: onSubmit fired", "Advanced Drop-in");
          const submittedPaymentMethod = stateData?.data?.paymentMethod || selectedNonCardPaymentMethodPayload();
          if (!submittedPaymentMethod?.type) {
            const message = "No payment method was submitted by Drop-in. Select a fetched payment method and try again.";
            dropinResult.textContent = message;
            addTimelineStep("frontend: missing paymentMethod", "Advanced Drop-in");
            if (actions?.reject) actions.reject();
            return;
          }
          const request = {
            endpoint: "/payments",
            adyenEndpoint: "/payments",
            callback: "onSubmit",
            payload: { ...basePaymentFields("payments"), paymentMethod: submittedPaymentMethod }
          };
          const response = await callBackend(request);
          addTimelineStep("backend: POST /payments", String(response.status));
          addTrace({
            time: new Date().toISOString(),
            mode: "backend",
            flow: selectedFlow(),
            operation: "payments",
            metadata: metadata(),
            idempotencyKey: idempotencyKeyFor(request),
            request,
            response,
            webhook: null
          });
          if (response.ok && actions?.resolve) actions.resolve(response.body?.adyen || response.body);
          if (!response.ok && actions?.reject) actions.reject();
        },
        onAdditionalDetails: async (stateData, component, actions) => {
          addTimelineStep("frontend: onAdditionalDetails fired", "Advanced Drop-in");
          const request = { endpoint: "/payments/details", adyenEndpoint: "/payments/details", callback: "onAdditionalDetails", payload: stateData.data };
          const response = await callBackend(request);
          addTimelineStep("backend: POST /payments/details", String(response.status));
          addTrace({
            time: new Date().toISOString(),
            mode: "backend",
            flow: selectedFlow(),
            operation: "details",
            metadata: metadata(),
            idempotencyKey: null,
            request,
            response,
            webhook: null
          });
          if (actions?.resolve) actions.resolve(response.body?.adyen || response.body);
        }
      });
      mountDropin(checkout, dropinMount);
      addTimelineStep("frontend: Drop-in mounted", "Advanced flow");
    } catch (error) {
      dropinMount.textContent = `Drop-in mount failed: ${error.message}`;
    }
  }

  function mockResponse(request) {
    if (request.endpoint === "/sessions") return { id: "MOCKSESSION", sessionData: "mock-session-data", reference: request.payload.reference, amount: request.payload.amount };
    if (request.endpoint === "/payment-methods") return { paymentMethods: [{ type: "scheme", name: "Cards" }, { type: "ideal", name: "iDEAL" }] };
    if (request.endpoint === "/payments/details") return { resultCode: "Authorised", pspReference: "MOCKDETAILS" };
    return { resultCode: "Authorised", pspReference: "MOCKPSP", merchantReference: request.payload.reference, amount: request.payload.amount };
  }

  function formatJson(value) {
    return JSON.stringify(value || {}, null, 2);
  }

  function blockElement(title, value, variant) {
    const section = document.createElement("details");
    section.className = `trace-block${variant ? ` ${variant}` : ""}`;
    const heading = document.createElement("summary");
    heading.textContent = title;
    const pre = document.createElement("pre");
    pre.textContent = formatJson(value);
    section.append(heading, pre);
    return section;
  }

  function apiCallElement(trace) {
    const card = document.createElement("section");
    card.className = "api-call-card";
    const endpoint = trace?.request?.adyenEndpoint || trace?.request?.endpoint || "not selected";
    const practiceEndpoint = trace?.request?.endpoint && trace.request.endpoint !== endpoint ? ` via ${trace.request.endpoint}` : "";
    const callback = trace?.request?.callback ? ` · ${trace.request.callback}` : "";
    card.innerHTML = `<strong>API call</strong><span>${endpoint}${practiceEndpoint}${callback}</span>`;
    return card;
  }

  function renderTraceBlocks(container, trace) {
    container.innerHTML = "";
    if (!trace) {
      container.append(apiCallElement(null));
      container.append(blockElement("Request", {}, ""));
      container.append(blockElement("Response", {}, ""));
      container.append(blockElement("Webhook", { status: "waiting_for_operation", matchingBy: ["merchantReference", "pspReference"] }, "webhook"));
      return;
    }
    const requestBlock = trace.request ? {
      endpoint: trace.request.adyenEndpoint,
      practiceEndpoint: trace.request.endpoint,
      callback: trace.request.callback || null,
      idempotencyKey: trace.idempotencyKey || null,
      metadata: trace.metadata,
      payload: trace.request.payload
    } : { error: trace.error || "request_not_built" };
    const responseBlock = trace.error ? { status: "error", message: trace.error } : trace.response;
    container.append(apiCallElement(trace));
    container.append(blockElement("Request", requestBlock, ""));
    container.append(blockElement("Response", responseBlock, trace.error ? "error" : ""));
    container.append(blockElement("Webhook", trace.webhook || { status: "waiting_for_matching_webhook", matchingBy: ["merchantReference", "pspReference"] }, "webhook"));
  }

  function addTrace(trace, options = {}) {
    if (options.preserveOrder && state.traces[0]?.time === trace.time) {
      state.traces[0] = trace;
    } else {
      state.traces.unshift(trace);
      state.traces = state.traces.slice(0, 40);
    }
    renderTraceBlocks(latestTraceBlocks, state.traces[0]);
    renderTraces();
    persistState();
  }

  function renderTraces() {
    traceList.innerHTML = "";
    if (!state.traces.length) {
      const empty = document.createElement("p");
      empty.className = "notice";
      empty.textContent = "No requests yet.";
      traceList.append(empty);
      return;
    }
    state.traces.forEach((trace) => {
      const item = document.createElement("article");
      item.className = "trace-item";
      const header = document.createElement("header");
      const title = document.createElement("strong");
      title.textContent = `${trace.metadata?.flow || trace.flow} · ${trace.request ? trace.request.adyenEndpoint : "not sent"}`;
      const status = document.createElement("span");
      status.className = `trace-status${trace.error ? " error" : ""}`;
      status.textContent = trace.error ? "error" : String(trace.response?.status || "mock");
      header.append(title, status);
      const blocks = document.createElement("div");
      blocks.className = "trace-blocks compact";
      renderTraceBlocks(blocks, trace);
      item.append(header, blocks);
      traceList.append(item);
    });
  }

  async function fetchWebhookEvents() {
    try {
      const response = await getBackend("/traces");
      return Array.isArray(response.body?.webhookEvents) ? response.body.webhookEvents : [];
    } catch {
      return [];
    }
  }

  function matchingWebhook(trace, events) {
    const reference = trace?.request?.payload?.reference || trace?.response?.body?.adyen?.merchantReference;
    const pspReference = trace?.response?.body?.adyen?.pspReference;
    return events.find((event) => (pspReference && event.pspReference === pspReference) || (reference && event.merchantReference === reference)) || null;
  }

  async function simulateWebhook() {
    const trace = state.traces[0];
    const adyenBody = trace?.response?.body?.adyen || {};
    const merchantReference = trace?.request?.payload?.reference || adyenBody.merchantReference || referenceValue();
    const pspReference = adyenBody.pspReference || `SIMULATED${Date.now()}`;
    const payload = {
      live: "false",
      notificationItems: [
        {
          NotificationRequestItem: {
            additionalData: {},
            amount: trace?.request?.payload?.amount || amountObject(),
            eventCode: "AUTHORISATION",
            merchantAccountCode: merchantAccount(),
            merchantReference,
            pspReference,
            success: "true"
          }
        }
      ]
    };
    const response = await postBackend("/webhooks/adyen", payload);
    const events = await fetchWebhookEvents();
    const match = matchingWebhook(trace, events) || events[0] || null;
    if (trace && match) {
      trace.webhook = match;
      addTrace(trace, { preserveOrder: true });
      addTimelineStep(`webhook: ${match.eventCode || "event"} received`, match.pspReference || match.merchantReference);
    } else {
      addTrace({
        time: new Date().toISOString(),
        mode: "backend",
        flow: selectedFlow(),
        operation: "webhook",
        metadata: metadata(),
        idempotencyKey: null,
        request: { endpoint: "/webhooks/adyen", adyenEndpoint: "webhook", payload },
        response,
        webhook: match
      });
    }
  }

  function scheduleWebhookPoll(trace) {
    if (selectedMode() !== "backend") return;
    if (state.webhookPollTimer) window.clearInterval(state.webhookPollTimer);
    let attempts = 0;
    state.webhookPollTimer = window.setInterval(async () => {
      attempts += 1;
      const match = matchingWebhook(trace, await fetchWebhookEvents());
      if (match) {
        trace.webhook = match;
        addTimelineStep(`webhook: ${match.eventCode || "event"} received`, match.pspReference || match.merchantReference);
        addTimelineStep("HMAC", `verified ${match.hmac?.verified}`);
        addTrace(trace, { preserveOrder: true });
        window.clearInterval(state.webhookPollTimer);
        state.webhookPollTimer = null;
      }
      if (attempts >= 20 && state.webhookPollTimer) {
        window.clearInterval(state.webhookPollTimer);
        state.webhookPollTimer = null;
      }
    }, 3000);
  }

  function renderVersionPanel(extraWarnings = []) {
    const warnings = [...extraWarnings];
    const webVersion = selectedWebVersion();
    const docsVersion = selectedDocsVersion();
    if (webVersion !== docsVersion) warnings.push("Loaded Adyen Web version does not match the docs version selected for this lab. Behavior or options may differ.");
    if (state.adyenWebLoadedVersion && state.adyenWebLoadedVersion !== webVersion) warnings.push("Selected Adyen Web version differs from the loaded SDK version. Remount Drop-in after changing versions.");
    if (state.adyenWebLoadedVersion && state.adyenWebCssVersion && state.adyenWebLoadedVersion !== state.adyenWebCssVersion) warnings.push("Adyen Web JS and CSS versions differ. Drop-in styling or behavior may be inconsistent.");
    if (state.backendConfig && !state.backendConfig.checkoutApiVersion) warnings.push("Could not determine Checkout API version from backend config.");

    versionPanel.innerHTML = "";
    const rows = {
      Environment: "test",
      "Flow mode": selectedFlow(),
      "Adyen Web selected": webVersion,
      "Adyen Web loaded": state.adyenWebLoadedVersion || state.adyenSdkStatus,
      "Adyen Web docs": docsVersion,
      "Checkout API version": checkoutApiVersion(),
      "Checkout API base URL": state.backendConfig?.checkoutApiBaseUrl || state.backendConfig?.checkoutBaseUrl || "not_loaded",
      "Backend API base URL": backendBaseUrl(),
      "Backend config loaded": state.backendConfig ? "true" : "false",
      "SDK JS/CSS match": state.adyenWebLoadedVersion && state.adyenWebCssVersion ? String(state.adyenWebLoadedVersion === state.adyenWebCssVersion) : "not_loaded"
    };
    Object.entries(rows).forEach(([label, value]) => {
      const row = document.createElement("div");
      row.className = "version-row";
      row.innerHTML = `<strong>${label}</strong><span>${String(value)}</span>`;
      versionPanel.append(row);
    });
    setWarnings(warnings);

    docLinks.innerHTML = "";
    [
      ["Sessions flow docs", docsUrl("sessions")],
      ["Advanced flow docs", docsUrl("advanced")],
      ["Web best practices", docsUrl("best-practices")]
    ].forEach(([label, href]) => {
      const link = document.createElement("a");
      link.href = href;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = label;
      docLinks.append(link);
    });
  }

  function renderModeExplainer() {
    const flow = selectedFlow();
    const version = selectedWebVersion();
    const apiVersion = checkoutApiVersion();
    const text = {
      "sessions-dropin": `Sessions Drop-in uses Adyen Web Drop-in v${version} in the browser and backend Checkout API /sessions on ${apiVersion}. It lets Adyen orchestrate more of checkout and can use beforeSubmit. Sensitive fields belong in Adyen-controlled iframe/hosted fields.`,
      "advanced-dropin": `Advanced Drop-in uses the same Adyen Web Drop-in v${version}, then calls backend /paymentMethods, /payments, and /payments/details on ${apiVersion}. It demonstrates onSubmit and onAdditionalDetails for merchants that need more control.`,
      "manual-api": `Manual API Lab primarily demonstrates Checkout API ${apiVersion} payloads. It does not mount Drop-in and does not collect raw card data in merchant-owned inputs. The Adyen Web version is shown only for docs/context.`
    };
    modeExplainer.textContent = text[flow];
  }

  function syncFlow() {
    const flow = selectedFlow();
    dropinPanel.hidden = flow === "manual-api";
    manualOnly.forEach((item) => {
      item.hidden = flow !== "manual-api";
    });
    renderManualParameterFields();
    renderModeExplainer();
    renderVersionPanel();
  }

  function rememberManualFieldValues() {
    manualParameterFields.querySelectorAll("input, select, textarea").forEach((field) => {
      manualFieldState[field.id] = field.value;
    });
  }

  function renderManualParameterFields() {
    if (!manualParameterFields) return;
    rememberManualFieldValues();
    manualParameterFields.innerHTML = "";
    if (selectedFlow() !== "manual-api") return;
    const operation = fieldValue("operation") || "payments";
    const fields = manualOperationFields[operation] || manualOperationFields.payments;
    const heading = document.createElement("div");
    heading.className = "panel-heading";
    heading.innerHTML = `<p class="eyebrow">Manual API parameters</p><h2>${operation} fields</h2>`;
    const grid = document.createElement("div");
    grid.className = "grid three";
    fields.forEach((field) => {
      const label = document.createElement("label");
      label.textContent = field.label;
      const input = field.options ? document.createElement("select") : document.createElement("input");
      input.id = field.id;
      input.name = field.id;
      if (field.options) {
        field.options.forEach(([value, text]) => {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = text;
          input.append(option);
        });
      } else {
        input.type = "text";
        input.autocomplete = "off";
      }
      input.value = manualFieldState[field.id] ?? field.value ?? "";
      label.append(input);
      grid.append(label);
    });
    manualParameterFields.append(heading, grid);
  }

  function persistState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      backendUrl: fieldValue("backendUrl"),
      merchantAccount: fieldValue("merchantAccount"),
      checkoutApiVersion: checkoutApiVersion(),
      selectedPaymentMethods: selectedPaymentMethodTypes(),
      adyenWebVersion: selectedWebVersion(),
      adyenDocsVersion: selectedDocsVersion(),
      traces: state.traces.slice(0, 10)
    }));
  }

  function restoreState() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      if (saved.backendUrl) byId("backendUrl").value = saved.backendUrl;
      if (saved.merchantAccount) byId("merchantAccount").value = saved.merchantAccount;
      if (saved.checkoutApiVersion && byId("checkoutApiVersion")) byId("checkoutApiVersion").value = saved.checkoutApiVersion;
      if (SUPPORTED_ADYEN_WEB_VERSIONS.includes(saved.adyenWebVersion)) byId("adyenWebVersion").value = saved.adyenWebVersion;
      if (SUPPORTED_ADYEN_WEB_VERSIONS.includes(saved.adyenDocsVersion)) byId("adyenDocsVersion").value = saved.adyenDocsVersion;
      if (Array.isArray(saved.selectedPaymentMethods)) state.selectedPaymentMethods = new Set(saved.selectedPaymentMethods);
      if (Array.isArray(saved.traces)) state.traces = saved.traces;
    } catch {
      state.traces = [];
    }
    syncFlow();
    renderPaymentMethodToggles();
    renderTraceBlocks(latestTraceBlocks, state.traces[0] || null);
    renderTraces();
    renderTimeline();
  }

  function setDrawerOpen(open) {
    drawer.classList.toggle("is-open", open);
    drawer.setAttribute("aria-hidden", open ? "false" : "true");
    scrim.hidden = !open;
  }

  function seedDemo() {
    byId("operation").value = "payments";
    byId("captureDelayHours").value = "manual";
    byId("amount").value = "1299";
    byId("currency").value = "EUR";
    byId("countryCode").value = "NL";
    byId("reference").value = `adyen-practice-test-${Date.now()}`;
    byId("shopperEmail").value = "test-shopper@adyen-practice.example";
    byId("shopperReference").value = "adyen-practice-shopper";
    byId("origin").value = window.location.protocol === "file:" ? "https://juanferbazo96.github.io" : window.location.origin;
    byId("threeDS2").checked = true;
    byId("lineItems").checked = true;
    byId("metadata").checked = true;
    persistState();
  }

  async function runOperation(event) {
    event.preventDefault();
    state.lastTimeline = [];
    addTimelineStep("frontend: run clicked", selectedFlow());
    await ensureConfig();
    const requestStartedAt = new Date().toISOString();
    try {
      const request = buildOperationRequest();
      const idempotencyKey = idempotencyKeyFor(request);
      const mode = selectedMode();
      let response;
      if (mode === "backend") {
        addTimelineStep(`backend: POST ${request.endpoint}`, request.callback || "manual");
        response = await callBackend(request, { idempotencyKey });
        addTimelineStep(`Adyen: POST ${request.adyenEndpoint}`, String(response.status));
      } else {
        response = { status: "mock", ok: true, body: mockResponse(request), headers: { idempotencyKey } };
      }
      if (request.endpoint === "/payment-methods" && response.ok) {
        state.paymentMethods = flattenPaymentMethods(response.body);
        if (!state.selectedPaymentMethods.size) {
          state.selectedPaymentMethods = new Set(state.paymentMethods.map((method) => method.type));
        }
        renderPaymentMethodToggles();
      }
      const trace = {
        time: requestStartedAt,
        mode,
        flow: selectedFlow(),
        operation: currentOperation(),
        metadata: metadata(),
        idempotencyKey,
        request,
        response,
        webhook: null
      };
      addTrace(trace);
      if (selectedFlow() === "sessions-dropin" && response.ok) await mountSessionsDropin(response);
      if (selectedFlow() === "advanced-dropin" && response.ok) await mountAdvancedDropin(response);
      scheduleWebhookPoll(trace);
    } catch (error) {
      addTrace({
        time: requestStartedAt,
        mode: selectedMode(),
        flow: selectedFlow(),
        operation: currentOperation(),
        metadata: metadata(),
        error: error.message,
        request: null,
        response: { status: "error", ok: false },
        webhook: null
      });
    }
  }

  async function runDiagnostics() {
    const diagnostics = [];
    const minimal = {
      merchantAccount: fieldValue("merchantAccount") || "AdyenPracticeECOM",
      amount: amountObject(),
      countryCode: fieldValue("countryCode") || "NL",
      shopperLocale: "en-US",
      channel: "Web"
    };
    const session = sessionPayload();
    const payment = { ...basePaymentFields("payments"), paymentMethod: paymentMethodPayload() };
    const steps = [
      { label: "GET /health", request: { endpoint: "/health", method: "GET" }, run: () => getBackend("/health") },
      { label: "GET /config", request: { endpoint: "/config", method: "GET" }, run: () => getBackend("/config") },
      { label: "POST /payment-methods", request: { endpoint: "/payment-methods", method: "POST", payload: minimal }, run: () => callBackend({ endpoint: "/payment-methods", adyenEndpoint: "/paymentMethods", payload: minimal }) },
      { label: "POST /sessions", request: { endpoint: "/sessions", method: "POST", payload: session }, run: () => callBackend({ endpoint: "/sessions", adyenEndpoint: "/sessions", payload: session }) },
      { label: "POST /payments", request: { endpoint: "/payments", method: "POST", payload: payment }, run: () => callBackend({ endpoint: "/payments", adyenEndpoint: "/payments", payload: payment }) }
    ];
    for (const step of steps) {
      try {
        diagnostics.push({ label: step.label, request: step.request, response: await step.run() });
      } catch (error) {
        diagnostics.push({ label: step.label, request: step.request, response: { status: "error", message: error.message } });
      }
    }
    diagnosticTraceBlocks.innerHTML = "";
    diagnostics.forEach((item) => {
      diagnosticTraceBlocks.append(blockElement(`${item.label} Request`, item.request, ""));
      diagnosticTraceBlocks.append(blockElement(`${item.label} Response`, item.response, item.response?.ok === false || item.response?.status === "error" ? "error" : ""));
    });
  }

  form.addEventListener("submit", runOperation);
  byId("buildPayload").addEventListener("click", () => {
    try {
      const request = buildOperationRequest();
      addTrace({
        time: new Date().toISOString(),
        mode: "preview",
        flow: selectedFlow(),
        operation: currentOperation(),
        metadata: metadata(),
        idempotencyKey: idempotencyKeyFor(request),
        request,
        response: { status: "not_sent", ok: true, body: null },
        webhook: null
      });
    } catch (error) {
      addTrace({ time: new Date().toISOString(), mode: "preview", flow: selectedFlow(), error: error.message, response: { status: "error", ok: false } });
    }
  });
  byId("clearLog").addEventListener("click", () => {
    state.traces = [];
    state.lastTimeline = [];
    renderTraceBlocks(latestTraceBlocks, null);
    renderTraces();
    renderTimeline();
    persistState();
  });
  byId("openDrawer").addEventListener("click", () => setDrawerOpen(true));
  byId("closeDrawer").addEventListener("click", () => setDrawerOpen(false));
  byId("loadConfig").addEventListener("click", ensureConfig);
  byId("runDiagnostics").addEventListener("click", runDiagnostics);
  byId("loadPaymentMethods").addEventListener("click", () => loadPaymentMethods({ trace: true }));
  byId("selectAllPaymentMethods").addEventListener("click", () => {
    state.selectedPaymentMethods = new Set(state.paymentMethods.map((method) => method.type));
    renderPaymentMethodToggles();
    persistState();
  });
  byId("simulateWebhook").addEventListener("click", simulateWebhook);
  scrim.addEventListener("click", () => setDrawerOpen(false));
  byId("seedDemo").addEventListener("click", seedDemo);
  form.addEventListener("change", () => {
    syncFlow();
    persistState();
  });
  restoreState();
  renderPaymentMethodToggles();
  ensureConfig().then(() => loadPaymentMethods()).catch(() => {});
})();
