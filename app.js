import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./supabase-config.js";

const supabase = window.supabase.createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true
    }
  }
);

let currentUser = null;
let currentEvent = null;
let membersCache = [];
let eventsCache = [];
let absencesCache = [];
let kitchenOverviewCache = [];
let kitchenAttendanceCache = [];
let settingsCache = {
  reminder_days: 2,
  reminder_channel: "mail"
};
let adminVisible = false;
let currentReminderEvent = null;
let authBusy = false;

const $ = (id) => document.getElementById(id);

function showMessage(text) {
  $("globalMessage").textContent = text;
  $("globalMessage").classList.remove("hidden");
  setTimeout(() => $("globalMessage").classList.add("hidden"), 2500);
}

function showError(text) {
  $("globalError").textContent = text;
  $("globalError").classList.remove("hidden");
  setTimeout(() => $("globalError").classList.add("hidden"), 4500);
}

function clearMessages() {
  $("globalMessage").classList.add("hidden");
  $("globalError").classList.add("hidden");
}

function setLoginBusy(isBusy) {
  const btn = $("loginBtn");
  if (!btn) return;
  btn.disabled = isBusy;
  btn.textContent = isBusy ? "Logger ind..." : "Log ind";
}

function formatDate(dateString) {
  const d = new Date(dateString + "T12:00:00");
  return d.toLocaleDateString("da-DK", {
    day: "numeric",
    month: "long",
    year: "numeric"
  });
}

function formatDeadline(event) {
  const date = new Date(`${event.date}T${event.time || "19:00"}:00`);
  date.setDate(date.getDate() - (Number(event.deadline_days) || 0));
  return (
    date.toLocaleDateString("da-DK", {
      day: "numeric",
      month: "short",
      year: "numeric"
    }) +
    " kl. " +
    String(date.getHours()).padStart(2, "0") +
    "." +
    String(date.getMinutes()).padStart(2, "0")
  );
}

function getDeadlineDate(event) {
  const date = new Date(`${event.date}T${event.time || "19:00"}:00`);
  date.setDate(date.getDate() - (Number(event.deadline_days) || 0));
  return date;
}

function isBeforeDeadline(event) {
  return new Date() <= getDeadlineDate(event);
}

function daysUntilDate(date) {
  const now = new Date();
  const startOfNow = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfTarget = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.round((startOfTarget - startOfNow) / 86400000);
}

function csvEscape(value) {
  const stringValue = String(value ?? "");
  if (stringValue.includes('"') || stringValue.includes(",") || stringValue.includes("\n")) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }
  return stringValue;
}

function downloadFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function copyToClipboard(text, successMessage) {
  try {
    await navigator.clipboard.writeText(text);
    showMessage(successMessage);
  } catch {
    showError("Kunne ikke kopiere til udklipsholder.");
  }
}

function getEventAbsences(eventId) {
  return absencesCache.filter((a) => a.event_id === eventId);
}

function getAttendanceRecord(memberId, eventId) {
  return getEventAbsences(eventId).find((a) => a.member_id === memberId) || null;
}

function isAbsent(memberId, eventId) {
  const member = membersCache.find((m) => m.id === memberId);
  const record = getAttendanceRecord(memberId, eventId);

  if (record) {
    return record.attending === false;
  }

  return !!member?.opt_in_only;
}

function getAttendingMembers(eventId) {
  return membersCache.filter((m) => !isAbsent(m.id, eventId));
}

function getAbsentMembers(eventId) {
  return membersCache.filter((m) => isAbsent(m.id, eventId));
}

function getCurrentAttendanceForUser() {
  if (!currentUser || !currentEvent) return null;
  return getAttendanceRecord(currentUser.id, currentEvent.id);
}

function getReminderCandidateEvent() {
  const reminderDays = Number(settingsCache.reminder_days ?? 2);

  const upcoming = eventsCache
    .filter((event) => {
      const eventDate = new Date(`${event.date}T${event.time || "19:00"}:00`);
      return eventDate >= new Date();
    })
    .sort((a, b) => {
      const aDate = new Date(`${a.date}T${a.time || "19:00"}:00`);
      const bDate = new Date(`${b.date}T${b.time || "19:00"}:00`);
      return aDate - bDate;
    });

  const exactMatch = upcoming.find((event) => {
    const eventDate = new Date(`${event.date}T${event.time || "19:00"}:00`);
    return daysUntilDate(eventDate) === reminderDays;
  });

  if (exactMatch) return exactMatch;

  return (
    upcoming.find((event) => {
      const eventDate = new Date(`${event.date}T${event.time || "19:00"}:00`);
      const daysUntilEvent = daysUntilDate(eventDate);
      return daysUntilEvent >= 0 && daysUntilEvent <= reminderDays && isBeforeDeadline(event);
    }) || null
  );
}

function buildReminderData(event) {
  if (!event) {
    return {
      event: null,
      attendingMembers: [],
      absentMembers: [],
      emails: [],
      phones: [],
      csv: "",
      text: ""
    };
  }

  const attendingMembers = getAttendingMembers(event.id);
  const absentMembers = getAbsentMembers(event.id);

  const emails = attendingMembers
    .map((m) => m.email?.trim())
    .filter(Boolean);

  const phones = attendingMembers
    .map((m) => m.phone?.trim())
    .filter(Boolean);

  const text =
    `Påmindelse om ${event.title}\n` +
    `${formatDate(event.date)} kl. ${event.time || "19:00"}\n` +
    `${event.location || ""}\n` +
    `Afmeldingsfrist: ${formatDeadline(event)}\n\n` +
    `Du kan opdatere din status på logeaften-siden.`;

  const header = "Navn,Mail,Telefon,Deltager,Mad,Gæst,Gæst med mad\n";
  const rows = membersCache.map((member) => {
    const record = getAttendanceRecord(member.id, event.id);
    const attending = !isAbsent(member.id, event.id);
    const wantsFood = attending
      ? (record ? record.wants_food !== false : !member.opt_in_only)
      : false;
    const bringsGuest = attending && record?.brings_guest === true;
    const guestFood = attending && record?.guest_wants_food === true;

    return [
      csvEscape(member.name || ""),
      csvEscape(member.email || ""),
      csvEscape(member.phone || ""),
      attending ? "Ja" : "Nej",
      wantsFood ? "Ja" : "Nej",
      bringsGuest ? csvEscape(record?.guest_name || "Ja") : "",
      guestFood ? "Ja" : "Nej"
    ].join(",");
  });

  return {
    event,
    attendingMembers,
    absentMembers,
    emails,
    phones,
    csv: header + rows.join("\n"),
    text
  };
}

function getKitchenOverviewForEvent(eventId) {
  return kitchenOverviewCache.find((x) => x.event_id === eventId) || null;
}

function getKitchenAttendanceForEvent(eventId) {
  return kitchenAttendanceCache.filter(
    (x) => x.event_id === eventId && (x.wants_food || (x.brings_guest && x.guest_wants_food))
  );
}

function buildKitchenText(eventId) {
  const overview = getKitchenOverviewForEvent(eventId);
  const rows = getKitchenAttendanceForEvent(eventId);

  if (!overview) return "Ingen køkkendata fundet.";

  const lines = [
    `${overview.title}`,
    `${formatDate(overview.date)} kl. ${overview.time || "19:00"}`,
    overview.location || "",
    "",
    `Deltagere: ${overview.attending_count}`,
    `Medlemmer med mad: ${overview.member_meals}`,
    `Gæster: ${overview.guest_count}`,
    `Gæster med mad: ${overview.guest_meals}`,
    `Total kuverter: ${overview.total_meals}`,
    "",
    "Navneliste:"
  ];

  rows.forEach((row) => {
    let line = `- ${row.member_name}`;

    if (row.wants_food) line += " · mad";
    if (row.brings_guest) {
      line += ` · gæst: ${row.guest_name || "Ja"}`;
      if (row.guest_wants_food) line += " (mad)";
    }

    lines.push(line);
  });

  return lines.join("\n");
}

function ensureAttendanceStatusField() {
  if ($("attendanceStatusSelect")) return;

  const guestFields = $("attendanceAdminGuestFields");
  const target = guestFields?.parentElement || $("saveAttendanceAdminBtn")?.parentElement;
  if (!target) return;

  const wrapper = document.createElement("div");
  wrapper.style.marginTop = "10px";
  wrapper.innerHTML = `
    <label for="attendanceStatusSelect">Status efter logeaften</label><br>
    <select id="attendanceStatusSelect">
      <option value="unknown">Ikke sat</option>
      <option value="present">Mødt</option>
      <option value="no_show">No-show</option>
      <option value="late_cancel">Sent afbud</option>
      <option value="excused_absence">Gyldigt fravær</option>
    </select>
  `;
  target.appendChild(wrapper);
}

function ensureKitchenPanel() {
  if ($("kitchenPanel")) return;

  const appArea = $("appArea");
  if (!appArea) return;

  const section = document.createElement("section");
  section.id = "kitchenPanel";
  section.className = "card hidden";
  section.innerHTML = `
    <h2>Restauratør-overblik</h2>

    <div style="margin-bottom:12px;">
      <label for="kitchenEventSelect">Logeaften</label><br>
      <select id="kitchenEventSelect"></select>
    </div>

    <div id="kitchenSummaryBox" class="success-box" style="margin-bottom:12px;"></div>

    <div style="margin-bottom:12px; display:flex; gap:8px; flex-wrap:wrap;">
      <button id="copyKitchenTextBtn" type="button">Kopiér køkkentekst</button>
      <button id="exportKitchenCsvBtn" type="button">Eksportér køkken-CSV</button>
    </div>

    <div id="kitchenNamesBox"></div>
  `;

  appArea.prepend(section);

  $("kitchenEventSelect").addEventListener("change", () => {
    const selectedId = Number($("kitchenEventSelect").value);
    const selectedEvent = eventsCache.find((e) => e.id === selectedId);
    if (selectedEvent) currentEvent = selectedEvent;
    renderAll();
  });

  $("copyKitchenTextBtn").addEventListener("click", async () => {
    const eventId = Number($("kitchenEventSelect").value);
    await copyToClipboard(buildKitchenText(eventId), "Køkkentekst kopieret.");
  });

  $("exportKitchenCsvBtn").addEventListener("click", () => {
    const eventId = Number($("kitchenEventSelect").value);
    const overview = getKitchenOverviewForEvent(eventId);
    const rows = getKitchenAttendanceForEvent(eventId);

    if (!overview) {
      showError("Ingen køkkendata fundet.");
      return;
    }

    const header = "Navn,Medlem mad,Gæst,Gæst med mad\n";
    const csvRows = rows.map((row) => [
      csvEscape(row.member_name || ""),
      row.wants_food ? "Ja" : "Nej",
      row.brings_guest ? csvEscape(row.guest_name || "Ja") : "",
      row.guest_wants_food ? "Ja" : "Nej"
    ].join(","));

    downloadFile(
      "koekkenoversigt.csv",
      header + csvRows.join("\n"),
      "text/csv;charset=utf-8;"
    );
  });
}

function renderKitchenPanel() {
  ensureKitchenPanel();

  const panel = $("kitchenPanel");
  if (!panel) return;

  const isKitchen = currentUser?.role === "kitchen";
  const isAdmin = currentUser?.role === "admin";

  panel.classList.toggle("hidden", !(isKitchen || isAdmin));

  if (!(isKitchen || isAdmin)) return;

  $("kitchenEventSelect").innerHTML = eventsCache
    .map((e) => `<option value="${e.id}">${e.title}</option>`)
    .join("");

  if (currentEvent) {
    $("kitchenEventSelect").value = String(currentEvent.id);
  }

  const eventId = Number($("kitchenEventSelect").value);
  const overview = getKitchenOverviewForEvent(eventId);
  const rows = getKitchenAttendanceForEvent(eventId);

  if (!overview) {
    $("kitchenSummaryBox").innerHTML = "Ingen køkkendata fundet.";
    $("kitchenNamesBox").innerHTML = "";
    return;
  }

  $("kitchenSummaryBox").innerHTML = `
    <strong>${overview.title}</strong><br>
    ${formatDate(overview.date)} kl. ${overview.time || "19:00"}<br>
    ${overview.location || ""}<br><br>
    Deltagere: ${overview.attending_count}<br>
    Medlemmer med mad: ${overview.member_meals}<br>
    Gæster: ${overview.guest_count}<br>
    Gæster med mad: ${overview.guest_meals}<br>
    <strong>Total kuverter: ${overview.total_meals}</strong>
  `;

  if (!rows.length) {
    $("kitchenNamesBox").innerHTML = `<div class="empty">Ingen madtilmeldinger endnu.</div>`;
    return;
  }

  $("kitchenNamesBox").innerHTML = rows.map((row) => {
    let text = `${row.member_name}`;
    if (row.wants_food) text += ` · mad`;
    if (row.brings_guest) {
      text += ` · gæst: ${row.guest_name || "Ja"}`;
      if (row.guest_wants_food) text += ` (mad)`;
    }

    return `<div class="member"><div><div class="member-name">${text}</div></div></div>`;
  }).join("");
}

function renderAuth() {
  const adminToggleBtn = $("adminToggleBtn");
  const adminPanel = $("adminPanel");

  if (currentUser) {
    $("authLoggedOut").classList.add("hidden");
    $("authLoggedIn").classList.remove("hidden");

    const roleLabel =
      currentUser.role === "admin"
        ? "Admin"
        : currentUser.role === "kitchen"
          ? "Restauratør"
          : "Broder";

    $("currentUserText").textContent =
      `${currentUser.name} · ${roleLabel} · ${currentUser.email || ""}`;
    $("appArea").classList.remove("hidden");
    if (currentUser.role === "kitchen") {
      $("attendanceForm").classList.add("hidden");
    } else {
      $("attendanceForm").classList.remove("hidden");
    }
    $("lastUpdated").classList.remove("hidden");
    $("authHelperText").textContent = "Du er logget ind med din personlige konto.";
  } else {
    $("authLoggedOut").classList.remove("hidden");
    $("authLoggedIn").classList.add("hidden");
    $("appArea").classList.add("hidden");
    $("attendanceForm").classList.add("hidden");
    $("lastUpdated").classList.add("hidden");
    if ($("quickActions")) $("quickActions").classList.add("hidden");
    adminVisible = false;
    $("authHelperText").textContent = "Log ind med din email og dit eget password.";
  }

  if (currentUser?.role === "admin") {
    adminToggleBtn.classList.remove("hidden");
  } else {
    adminToggleBtn.classList.add("hidden");
    adminPanel.classList.add("hidden");
    adminVisible = false;
  }
}

function renderEvents() {
  $("eventList").innerHTML = "";

  if (!currentEvent && eventsCache.length > 0) {
    currentEvent = eventsCache[0];
  }

  eventsCache.forEach((event) => {
    const absent = getAbsentMembers(event.id).length;
    const attending = membersCache.length - absent;

    let myStatusLine = "";

    if (currentUser) {
      const record = getAttendanceRecord(currentUser.id, event.id);
      const isUserAbsent = isAbsent(currentUser.id, event.id);

      if (isUserAbsent) {
        myStatusLine = "❌ Du deltager ikke";
      } else {
        const wantsFood = record ? record.wants_food !== false : !currentUser.opt_in_only;
        myStatusLine = wantsFood
          ? "✅ Du deltager · 🍽️ Med mad"
          : "✅ Du deltager · 🚫 Uden mad";
      }
    }

    const btn = document.createElement("button");
    btn.className =
      "event-btn" + (currentEvent && currentEvent.id === event.id ? " active" : "");
    btn.innerHTML = `
      <div class="event-title">${event.title}</div>
      <div class="event-meta">${formatDate(event.date)} kl. ${event.time || "19:00"}</div>
      <div class="event-meta">Forventet fremmøde: ${attending}/${membersCache.length}</div>
      <div class="event-meta">Frist: ${formatDeadline(event)}</div>
      ${myStatusLine ? `<div class="event-meta"><strong>${myStatusLine}</strong></div>` : ""}
    `;

    btn.addEventListener("click", async () => {
      currentEvent = event;
      renderAll();
      await loadMyAttendanceIntoForm();

      if (window.innerWidth <= 1024) {
        const overviewCard = document.getElementById("overviewCard");
        if (overviewCard) {
          overviewCard.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      }
    });

    $("eventList").appendChild(btn);
  });
}

function renderStats() {
  if (!currentEvent) return;

  const absentMembers = getAbsentMembers(currentEvent.id);
  const attendingMembers = getAttendingMembers(currentEvent.id);

  const attendingCountEl = $("attendingCount");
  const absentCountEl = $("absentCount");
  const totalCountEl = $("totalCount");
  const deadlineTextEl = $("deadlineText");
  const mealsCountEl = $("mealsCount");
  const guestCountEl = $("guestCount");
  const guestMealsCountEl = $("guestMealsCount");
  const totalMealsCountEl = $("totalMealsCount");
  const mealsTotalStatEl = $("mealsTotalStat");

  if (attendingCountEl) attendingCountEl.textContent = attendingMembers.length;
  if (absentCountEl) absentCountEl.textContent = absentMembers.length;
  if (totalCountEl) totalCountEl.textContent = membersCache.length;
  if (deadlineTextEl) deadlineTextEl.textContent = formatDeadline(currentEvent);

  const mealsCount = attendingMembers.filter((member) => {
    const record = getAttendanceRecord(member.id, currentEvent.id);

    if (!record) {
      return !member.opt_in_only;
    }

    return record.wants_food !== false;
  }).length;

  const guestCount = attendingMembers.filter((member) => {
    const record = getAttendanceRecord(member.id, currentEvent.id);
    return record?.brings_guest === true;
  }).length;

  const guestMealsCount = attendingMembers.filter((member) => {
    const record = getAttendanceRecord(member.id, currentEvent.id);
    return record?.brings_guest === true && record?.guest_wants_food === true;
  }).length;

  const totalMeals = mealsCount + guestMealsCount;

  if (mealsCountEl) mealsCountEl.textContent = mealsCount;
  if (guestCountEl) guestCountEl.textContent = guestCount;
  if (guestMealsCountEl) guestMealsCountEl.textContent = guestMealsCount;
  if (totalMealsCountEl) totalMealsCountEl.textContent = totalMeals;
  if (mealsTotalStatEl) mealsTotalStatEl.textContent = totalMeals;
}

function renderEventInfo() {
  if (!currentEvent) return;

  $("eventInfo").innerHTML = `
    <div style="font-size: 24px; font-weight: 800; margin-bottom: 6px;">${currentEvent.title}</div>
    <div class="muted">${formatDate(currentEvent.date)} kl. ${currentEvent.time || "19:00"} · ${currentEvent.location || ""}</div>
  `;
}

function renderMembers() {
  if (!currentEvent) return;

  const attending = getAttendingMembers(currentEvent.id);
  const absent = getAbsentMembers(currentEvent.id);

  $("attendingList").innerHTML = "";
  $("absentList").innerHTML = "";

  attending.forEach((member) => {
    const record = getAttendanceRecord(member.id, currentEvent.id);
    const guestText = record?.brings_guest ? ` · Gæst: ${record.guest_name || "Ja"}` : "";
    const foodText = record?.wants_food === false ? " · Uden mad" : " · Med mad";

    const item = document.createElement("div");
    item.className = "member";
    item.innerHTML = `
      <div>
        <div class="member-name">${member.name}</div>
        <div class="muted">${foodText}${guestText}</div>
      </div>
    `;
    $("attendingList").appendChild(item);
  });

  if (absent.length === 0) {
    $("absentList").innerHTML = `<div class="empty">Ingen har meldt fra endnu.</div>`;
  } else {
    absent.forEach((member) => {
      const record = getAttendanceRecord(member.id, currentEvent.id);

      let statusText = "Har meldt fra";
      if (!record && member.opt_in_only) {
        statusText = "Ikke automatisk tilmeldt";
      }

      const item = document.createElement("div");
      item.className = "member";
      item.innerHTML = `
        <div>
          <div class="member-name">${member.name}</div>
          <div class="muted">${statusText}</div>
        </div>
      `;
      $("absentList").appendChild(item);
    });
  }
}

function renderMemberAction() {
  if (!currentUser || !currentEvent || currentUser.role === "kitchen") return;

  const absent = isAbsent(currentUser.id, currentEvent.id);
  const beforeDeadline = isBeforeDeadline(currentEvent);
  const boxClass = absent ? "warning" : "success-box";
  const statusIcon = absent ? "❌" : "✅";

  $("memberActionBox").innerHTML = `
    <div class="${boxClass}">
      <strong>${statusIcon} ${currentUser.name}</strong><br>
      ${absent ? "Du står aktuelt som ikke deltagende." : "Du står aktuelt som deltagende."}
      ${currentUser.opt_in_only ? '<br><span class="mini">Denne broder er ikke automatisk tilmeldt som standard og skal selv melde sig til.</span>' : ""}
      ${!beforeDeadline ? '<br><span class="mini">Afmeldingsfristen er overskredet. Kun admin kan ændre efter fristen.</span>' : ""}
    </div>
  `;
  $("quickActions").classList.remove("hidden");
}

async function loadMyAttendanceIntoForm() {
  if (!currentUser || !currentEvent) return;

  const record = getCurrentAttendanceForUser();

  if (!record) {
    $("attending").checked = !currentUser.opt_in_only;
    $("wantsFood").checked = !currentUser.opt_in_only;
    $("bringsGuest").checked = false;
    $("guestName").value = "";
    $("guestWantsFood").checked = false;
    $("guestFields").classList.add("hidden");
    return;
  }

  $("attending").checked = record.attending !== false;
  $("wantsFood").checked = record.wants_food !== false;
  $("bringsGuest").checked = record.brings_guest === true;
  $("guestName").value = record.guest_name || "";
  $("guestWantsFood").checked = record.guest_wants_food === true;
  $("guestFields").classList.toggle("hidden", record.brings_guest !== true);
}

function renderReminderPreview() {
  if (!currentUser || currentUser.role !== "admin") return;
  currentReminderEvent = getReminderCandidateEvent();
  const reminderData = buildReminderData(currentReminderEvent);

  if (!currentReminderEvent) {
    $("reminderPreview").innerHTML = "Ingen påmindelser klar endnu.";
    return;
  }

  $("reminderPreview").innerHTML = `
    <strong>${currentReminderEvent.title}</strong><br>
    ${formatDate(currentReminderEvent.date)} kl. ${currentReminderEvent.time || "19:00"}<br>
    ${currentReminderEvent.location || ""}<br>
    Frist: ${formatDeadline(currentReminderEvent)}<br><br>
    Deltagere med kontaktinfo: ${reminderData.emails.length} mail / ${reminderData.phones.length} telefonnumre
  `;
}

function getAdminSelectedEvent() {
  const id = Number($("attendanceAdminEventSelect")?.value);
  return eventsCache.find((e) => e.id === id) || null;
}

function getAdminSelectedMember() {
  const id = Number($("attendanceAdminMemberSelect")?.value);
  return membersCache.find((m) => m.id === id) || null;
}

function loadAdminAttendanceForm() {
  ensureAttendanceStatusField();

  const event = getAdminSelectedEvent();
  const member = getAdminSelectedMember();

  if (!event || !member) return;

  const record = getAttendanceRecord(member.id, event.id);
  const absent = isAbsent(member.id, event.id);
  const attending = !absent;

  $("attendanceAdminStatusText").textContent = `${member.name} · ${event.title}`;
  $("attendanceAdminAttending").checked = attending;

  if (!record) {
    $("attendanceAdminWantsFood").checked = attending ? !member.opt_in_only : false;
    $("attendanceAdminBringsGuest").checked = false;
    $("attendanceAdminGuestName").value = "";
    $("attendanceAdminGuestWantsFood").checked = false;
    $("attendanceAdminGuestFields").classList.add("hidden");
    const statusSelect = $("attendanceStatusSelect");
    if (statusSelect) statusSelect.value = "unknown";
    return;
  }

  $("attendanceAdminWantsFood").checked = attending ? record.wants_food !== false : false;
  $("attendanceAdminBringsGuest").checked = attending && record.brings_guest === true;
  $("attendanceAdminGuestName").value = record.guest_name || "";
  $("attendanceAdminGuestWantsFood").checked = attending && record.guest_wants_food === true;
  $("attendanceAdminGuestFields").classList.toggle(
    "hidden",
    !(attending && record.brings_guest === true)
  );

  const statusSelect = $("attendanceStatusSelect");
  if (statusSelect) {
    statusSelect.value = record?.attendance_status || "unknown";
  }
}

function renderAdmin() {
  const isAdmin = currentUser?.role === "admin";
  $("adminArea").classList.toggle("hidden", !isAdmin);
  $("adminPanel").classList.toggle("hidden", !isAdmin || !adminVisible);

  if (!isAdmin) return;

  $("reminderDaysInput").value = settingsCache.reminder_days ?? 2;
  $("reminderChannelInput").value = settingsCache.reminder_channel ?? "mail";

  $("eventAdminSelect").innerHTML = eventsCache
    .map((e) => `<option value="${e.id}">${e.title}</option>`)
    .join("");

  $("memberAdminSelect").innerHTML = membersCache
    .map((m) => `<option value="${m.id}">${m.name}</option>`)
    .join("");

  $("attendanceAdminEventSelect").innerHTML = eventsCache
    .map((e) => `<option value="${e.id}">${e.title}</option>`)
    .join("");

  $("attendanceAdminMemberSelect").innerHTML = membersCache
    .map((m) => `<option value="${m.id}">${m.name}</option>`)
    .join("");

  if (currentEvent) {
    $("attendanceAdminEventSelect").value = String(currentEvent.id);
  }

  fillEventEditForm();
  fillMemberEditForm();
  loadAdminAttendanceForm();
  renderReminderPreview();
}

function fillEventEditForm() {
  const id = Number($("eventAdminSelect").value);
  const event = eventsCache.find((e) => e.id === id);
  if (!event) return;

  $("editEventTitle").value = event.title || "";
  $("editEventDate").value = event.date || "";
  $("editEventTime").value = event.time || "";
  $("editEventLocation").value = event.location || "";
  $("editEventDeadlineDays").value = event.deadline_days ?? 2;
}

function fillMemberEditForm() {
  const id = Number($("memberAdminSelect").value);
  const member = membersCache.find((m) => m.id === id);
  if (!member) return;

  $("memberEmailInput").value = member.email || "";
  $("memberPhoneInput").value = member.phone || "";
  $("memberOptInOnlyInput").checked = !!member.opt_in_only;
  $("memberRoleInput").value = member.role || "member";
}

function renderAll() {
  renderAuth();
  renderEvents();
  renderStats();
  renderEventInfo();
  renderMembers();
  renderMemberAction();
  renderAdmin();
  renderKitchenPanel();
}

function resetAppStateAfterLogout() {
  currentUser = null;
  currentEvent = null;
  adminVisible = false;
  currentReminderEvent = null;
  membersCache = [];
  eventsCache = [];
  absencesCache = [];
  kitchenOverviewCache = [];
  kitchenAttendanceCache = [];
  settingsCache = {
    reminder_days: 2,
    reminder_channel: "mail"
  };
  $("loginPassword").value = "";
  renderAll();
}

async function loadAllData() {
  clearMessages();

  const isAdmin = currentUser?.role === "admin";
  const isKitchen = currentUser?.role === "kitchen";

  const settingsPromise = isAdmin
    ? supabase.from("settings").select("*").limit(1).maybeSingle()
    : Promise.resolve({ data: null, error: null });

  const kitchenOverviewPromise = (isAdmin || isKitchen)
    ? supabase.from("kitchen_overview_detailed").select("*").order("date")
    : Promise.resolve({ data: [], error: null });

  const kitchenAttendancePromise = (isAdmin || isKitchen)
    ? supabase.from("kitchen_attendance_list").select("*").order("date").order("member_name")
    : Promise.resolve({ data: [], error: null });

  const [
    { data: members, error: membersError },
    { data: events, error: eventsError },
    { data: absences, error: absencesError },
    { data: settings, error: settingsError },
    { data: kitchenOverview, error: kitchenOverviewError },
    { data: kitchenAttendance, error: kitchenAttendanceError }
  ] = await Promise.all([
    supabase.from("members_public").select("*").order("name"),
    supabase.from("events").select("*").order("date"),
    supabase.from("absences").select("*"),
    settingsPromise,
    kitchenOverviewPromise,
    kitchenAttendancePromise
  ]);

  if (membersError) throw membersError;
  if (eventsError) throw eventsError;
  if (absencesError) throw absencesError;
  if (settingsError) throw settingsError;
  if (kitchenOverviewError) throw kitchenOverviewError;
  if (kitchenAttendanceError) throw kitchenAttendanceError;

  membersCache = members || [];
  eventsCache = events || [];
  absencesCache = absences || [];
  kitchenOverviewCache = kitchenOverview || [];
  kitchenAttendanceCache = kitchenAttendance || [];
  if (settings) settingsCache = settings;

  if (!currentEvent && eventsCache.length > 0) {
    currentEvent = eventsCache[0];
  }

  if (currentEvent) {
    const refreshedCurrent = eventsCache.find((e) => e.id === currentEvent.id);
    if (refreshedCurrent) currentEvent = refreshedCurrent;
  }

  $("lastUpdated").textContent =
    "Opdateret: " + new Date().toLocaleTimeString("da-DK");
}

async function hydrateCurrentUserFromAuthUser(authUser) {
  if (!authUser) {
    currentUser = null;
    return;
  }

  const { data: member, error: memberError } = await supabase
    .from("members")
    .select("*")
    .eq("user_id", authUser.id)
    .maybeSingle();

  if (memberError) throw memberError;

  if (!member) {
    currentUser = null;
    throw new Error("Din bruger er ikke koblet til et medlem i databasen endnu.");
  }

  currentUser = member;
}

async function hydrateCurrentUser() {
  const {
    data: { session },
    error: sessionError
  } = await supabase.auth.getSession();

  if (sessionError) throw sessionError;

  await hydrateCurrentUserFromAuthUser(session?.user || null);
}

async function performLogin(email, password) {
  if (!email?.trim()) {
    showError("Skriv din email.");
    return false;
  }
  if (!password?.trim()) {
    showError("Skriv dit password.");
    return false;
  }

  if (authBusy) return false;
  authBusy = true;
  setLoginBusy(true);
  clearMessages();

  try {
    const { data, error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password
    });

    if (error) {
      showError("Forkert email eller password.");
      return false;
    }

    await hydrateCurrentUserFromAuthUser(data.user);
    await loadAllData();
    renderAll();
    await loadMyAttendanceIntoForm();
    $("setupNotice").classList.add("hidden");
    showMessage("Du er logget ind.");
    return true;
  } catch (err) {
    console.error(err);
    showError(err.message || "Kunne ikke hente din bruger.");
    return false;
  } finally {
    authBusy = false;
    setLoginBusy(false);
  }
}

async function quickSetAttendance(attending) {
  if (!currentUser || !currentEvent) return;

  if (!isBeforeDeadline(currentEvent) && currentUser.role !== "admin") {
    showError("Afmeldingsfristen er overskredet.");
    return;
  }

  const existingRecord = getCurrentAttendanceForUser();

  const payload = {
    member_id: currentUser.id,
    event_id: currentEvent.id,
    attending,
    wants_food: attending ? true : false,
    brings_guest: attending ? (existingRecord?.brings_guest ?? false) : false,
    guest_name: attending ? (existingRecord?.guest_name ?? null) : null,
    guest_wants_food: attending ? (existingRecord?.guest_wants_food ?? false) : false
  };

  const { error } = await supabase
    .from("absences")
    .upsert(payload, { onConflict: "event_id,member_id" });

  if (error) {
    console.error(error);
    showError("Kunne ikke gemme.");
    return;
  }

  await loadAllData();
  renderAll();
  await loadMyAttendanceIntoForm();
  showMessage(attending ? "Du er nu markeret som deltagende." : "Du er nu markeret som ikke deltagende.");
}

function exportKitchenCsv() {
  if (!currentEvent) {
    showError("Vælg en logeaften først.");
    return;
  }

  const header = "Navn,Deltager,Mad,Gæst,Gæst med mad\n";
  const rows = membersCache.map((member) => {
    const record = getAttendanceRecord(member.id, currentEvent.id);
    const attending = !isAbsent(member.id, currentEvent.id);
    const wantsFood = attending
      ? (record ? record.wants_food !== false : !member.opt_in_only)
      : false;
    const guest = attending && record?.brings_guest ? record?.guest_name || "Ja" : "";
    const guestFood = attending && record?.guest_wants_food === true;

    return [
      csvEscape(member.name || ""),
      attending ? "Ja" : "Nej",
      wantsFood ? "Ja" : "Nej",
      csvEscape(guest),
      guestFood ? "Ja" : "Nej"
    ].join(",");
  });

  downloadFile("koekkenliste.csv", header + rows.join("\n"), "text/csv;charset=utf-8;");
}

$("loginBtn").addEventListener("click", async () => {
  await performLogin($("loginEmail").value, $("loginPassword").value);
});

$("logoutBtn").addEventListener("click", async () => {
  await supabase.auth.signOut();
  resetAppStateAfterLogout();
  showMessage("Du er logget ud.");
});

$("adminToggleBtn").addEventListener("click", () => {
  if (currentUser?.role !== "admin") return;
  adminVisible = !adminVisible;
  renderAdmin();
});

$("togglePasswordBtn")?.addEventListener("click", () => {
  const input = $("loginPassword");
  const isPassword = input.type === "password";
  input.type = isPassword ? "text" : "password";
  $("togglePasswordBtn").textContent = isPassword ? "Skjul" : "Vis";
});

["loginEmail", "loginPassword"].forEach((id) => {
  $(id).addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("loginBtn").click();
  });
});

$("forgotPasswordBtn")?.addEventListener("click", async () => {
  const email = $("loginEmail").value.trim();
  if (!email) {
    showError("Skriv din email først.");
    return;
  }

  const redirectTo = `${window.location.origin}${window.location.pathname}`;
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });

  if (error) {
    console.error(error);
    showError("Kunne ikke sende nulstillingsmail.");
    return;
  }

  showMessage("Nulstillingsmail er sendt.");
});

$("changePasswordBtn")?.addEventListener("click", async () => {
  const newPassword = $("newPassword").value;
  const confirmPassword = $("confirmPassword").value;

  if (!newPassword || newPassword.length < 10) {
    showError("Det nye password skal være mindst 10 tegn.");
    return;
  }

  if (newPassword !== confirmPassword) {
    showError("De to passwords er ikke ens.");
    return;
  }

  const { error } = await supabase.auth.updateUser({ password: newPassword });

  if (error) {
    console.error(error);
    showError("Kunne ikke opdatere password.");
    return;
  }

  $("newPassword").value = "";
  $("confirmPassword").value = "";
  showMessage("Dit password er opdateret.");
});

$("quickAttendBtn")?.addEventListener("click", async () => {
  $("attending").checked = true;
  $("wantsFood").checked = true;
  await quickSetAttendance(true);
});

$("quickAbsentBtn")?.addEventListener("click", async () => {
  $("attending").checked = false;
  $("wantsFood").checked = false;
  await quickSetAttendance(false);
});

$("attending").addEventListener("change", () => {
  $("wantsFood").checked = $("attending").checked;

  if (!$("attending").checked) {
    $("bringsGuest").checked = false;
    $("guestName").value = "";
    $("guestWantsFood").checked = false;
    $("guestFields").classList.add("hidden");
  }
});

$("bringsGuest").addEventListener("change", () => {
  const showGuest = $("attending").checked && $("bringsGuest").checked;
  $("guestFields").classList.toggle("hidden", !showGuest);

  if (!showGuest) {
    $("guestName").value = "";
    $("guestWantsFood").checked = false;
  }
});

$("saveBtn").addEventListener("click", async () => {
  if (!currentUser || !currentEvent) return;

  if (!isBeforeDeadline(currentEvent) && currentUser.role !== "admin") {
    showError("Afmeldingsfristen er overskredet.");
    return;
  }

  const attending = $("attending").checked;
  const bringsGuest = attending ? $("bringsGuest").checked : false;
  const guestName = $("guestName").value.trim();

  if (bringsGuest && !guestName) {
    showError("Skriv gæstens navn.");
    return;
  }

  const payload = {
    member_id: currentUser.id,
    event_id: currentEvent.id,
    attending,
    wants_food: attending ? $("wantsFood").checked : false,
    brings_guest: bringsGuest,
    guest_name: attending && bringsGuest ? guestName : null,
    guest_wants_food: attending && bringsGuest ? $("guestWantsFood").checked : false
  };

  const { error } = await supabase
    .from("absences")
    .upsert(payload, { onConflict: "event_id,member_id" });

  if (error) {
    console.error(error);
    showError("Kunne ikke gemme.");
    return;
  }

  await loadAllData();
  renderAll();
  await loadMyAttendanceIntoForm();
  showMessage("Din tilmelding er gemt.");
});

$("refreshBtn")?.addEventListener("click", async () => {
  try {
    await loadAllData();
    renderAll();
    await loadMyAttendanceIntoForm();
    showMessage("Data er opdateret.");
  } catch (err) {
    console.error(err);
    showError("Kunne ikke opdatere data.");
  }
});

$("exportBtn")?.addEventListener("click", () => {
  const blob = new Blob(
    [
      JSON.stringify(
        {
          members: membersCache,
          events: eventsCache,
          absences: absencesCache,
          settings: settingsCache
        },
        null,
        2
      )
    ],
    { type: "application/json" }
  );

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "loge-data.json";
  a.click();
  URL.revokeObjectURL(url);
});

$("exportCsvBtn")?.addEventListener("click", exportKitchenCsv);

$("eventAdminSelect")?.addEventListener("change", fillEventEditForm);
$("memberAdminSelect")?.addEventListener("change", fillMemberEditForm);

$("attendanceAdminEventSelect")?.addEventListener("change", loadAdminAttendanceForm);
$("attendanceAdminMemberSelect")?.addEventListener("change", loadAdminAttendanceForm);

$("attendanceAdminAttending")?.addEventListener("change", () => {
  const attending = $("attendanceAdminAttending").checked;

  if (!attending) {
    $("attendanceAdminWantsFood").checked = false;
    $("attendanceAdminBringsGuest").checked = false;
    $("attendanceAdminGuestName").value = "";
    $("attendanceAdminGuestWantsFood").checked = false;
    $("attendanceAdminGuestFields").classList.add("hidden");
    return;
  }

  $("attendanceAdminWantsFood").checked = true;
  $("attendanceAdminGuestFields").classList.toggle(
    "hidden",
    !$("attendanceAdminBringsGuest").checked
  );
});

$("attendanceAdminBringsGuest")?.addEventListener("change", () => {
  const showGuest =
    $("attendanceAdminAttending").checked &&
    $("attendanceAdminBringsGuest").checked;

  $("attendanceAdminGuestFields").classList.toggle("hidden", !showGuest);

  if (!showGuest) {
    $("attendanceAdminGuestName").value = "";
    $("attendanceAdminGuestWantsFood").checked = false;
  }
});

$("saveAttendanceAdminBtn")?.addEventListener("click", async () => {
  if (currentUser?.role !== "admin") {
    showError("Kun admin kan ændre andre medlemmers tilmelding.");
    return;
  }

  const event = getAdminSelectedEvent();
  const member = getAdminSelectedMember();

  if (!event || !member) {
    showError("Vælg både logeaften og broder.");
    return;
  }

  const attending = $("attendanceAdminAttending").checked;
  const wantsFood = attending ? $("attendanceAdminWantsFood").checked : false;
  const bringsGuest = attending ? $("attendanceAdminBringsGuest").checked : false;
  const guestName = $("attendanceAdminGuestName").value.trim();
  const guestWantsFood =
    attending && bringsGuest ? $("attendanceAdminGuestWantsFood").checked : false;

  if (bringsGuest && !guestName) {
    showError("Skriv gæstens navn.");
    return;
  }

  const attendanceStatus = $("attendanceStatusSelect")?.value || "unknown";

  const payload = {
    member_id: member.id,
    event_id: event.id,
    attending,
    wants_food: wantsFood,
    brings_guest: bringsGuest,
    guest_name: bringsGuest ? guestName : null,
    guest_wants_food: guestWantsFood,
    attendance_status: attendanceStatus,
    attendance_marked_at: new Date().toISOString(),
    attendance_marked_by: currentUser.id
  };

  const { error } = await supabase
    .from("absences")
    .upsert(payload, { onConflict: "event_id,member_id" });

  if (error) {
    console.error(error);
    showError("Kunne ikke gemme tilmeldingen.");
    return;
  }

  await loadAllData();
  renderAll();
  await loadMyAttendanceIntoForm();
  loadAdminAttendanceForm();
  showMessage(`Tilmelding gemt for ${member.name}.`);
});

$("addEventBtn")?.addEventListener("click", async () => {
  const payload = {
    title: $("newEventTitle").value.trim(),
    date: $("newEventDate").value,
    time: $("newEventTime").value || "19:00",
    location: $("newEventLocation").value.trim(),
    deadline_days: Number($("newEventDeadlineDays").value || 2)
  };

  if (!payload.title || !payload.date) {
    showError("Udfyld titel og dato.");
    return;
  }

  const { error } = await supabase.from("events").insert(payload);

  if (error) {
    console.error(error);
    showError("Kunne ikke oprette logeaften.");
    return;
  }

  $("newEventTitle").value = "";
  $("newEventDate").value = "";
  $("newEventTime").value = "19:00";
  $("newEventLocation").value = "Frederiksgade 15, Slagelse";
  $("newEventDeadlineDays").value = "2";

  await loadAllData();
  renderAll();
  showMessage("Logeaften oprettet.");
});

$("saveEventBtn")?.addEventListener("click", async () => {
  const id = Number($("eventAdminSelect").value);

  const payload = {
    title: $("editEventTitle").value.trim(),
    date: $("editEventDate").value,
    time: $("editEventTime").value,
    location: $("editEventLocation").value.trim(),
    deadline_days: Number($("editEventDeadlineDays").value || 2)
  };

  const { error } = await supabase
    .from("events")
    .update(payload)
    .eq("id", id);

  if (error) {
    console.error(error);
    showError("Kunne ikke gemme logeaften.");
    return;
  }

  await loadAllData();
  renderAll();
  showMessage("Logeaften gemt.");
});

$("deleteEventBtn")?.addEventListener("click", async () => {
  const id = Number($("eventAdminSelect").value);

  if (!confirm("Vil du slette denne logeaften?")) return;

  const { error } = await supabase
    .from("events")
    .delete()
    .eq("id", id);

  if (error) {
    console.error(error);
    showError("Kunne ikke slette logeaften.");
    return;
  }

  currentEvent = null;
  await loadAllData();
  renderAll();
  showMessage("Logeaften slettet.");
});

$("saveMemberBtn")?.addEventListener("click", async () => {
  const id = Number($("memberAdminSelect").value);

  const payload = {
    email: $("memberEmailInput").value.trim(),
    phone: $("memberPhoneInput").value.trim(),
    opt_in_only: $("memberOptInOnlyInput").checked,
    role: $("memberRoleInput").value
  };

  const { error } = await supabase
    .from("members")
    .update(payload)
    .eq("id", id);

  if (error) {
    console.error(error);
    showError("Kunne ikke gemme medlem.");
    return;
  }

  await loadAllData();
  renderAll();
  showMessage("Medlem gemt.");
});

$("saveReminderBtn")?.addEventListener("click", async () => {
  const payload = {
    id: settingsCache.id || 1,
    reminder_days: Number($("reminderDaysInput").value || 2),
    reminder_channel: $("reminderChannelInput").value
  };

  const { error } = await supabase.from("settings").upsert(payload);

  if (error) {
    console.error(error);
    showError("Kunne ikke gemme indstillinger.");
    return;
  }

  await loadAllData();
  renderAll();
  showMessage("Indstillinger gemt.");
});

$("copyReminderBtn")?.addEventListener("click", async () => {
  const reminderData = buildReminderData(currentReminderEvent);
  if (!reminderData.event) {
    showError("Ingen reminder klar.");
    return;
  }
  await copyToClipboard(reminderData.text, "Remindertekst kopieret.");
});

$("openReminderMailBtn")?.addEventListener("click", () => {
  const reminderData = buildReminderData(currentReminderEvent);
  if (!reminderData.event) {
    showError("Ingen reminder klar.");
    return;
  }

  const subject = encodeURIComponent(`Påmindelse: ${reminderData.event.title}`);
  const body = encodeURIComponent(reminderData.text);
  const recipients = reminderData.emails.join(",");

  window.location.href = `mailto:${recipients}?subject=${subject}&body=${body}`;
});

$("copyPhonesBtn")?.addEventListener("click", async () => {
  const reminderData = buildReminderData(currentReminderEvent);
  if (!reminderData.event) {
    showError("Ingen reminder klar.");
    return;
  }
  await copyToClipboard(reminderData.phones.join(", "), "Telefonliste kopieret.");
});

$("exportReminderCsvBtn")?.addEventListener("click", () => {
  const reminderData = buildReminderData(currentReminderEvent);
  if (!reminderData.event) {
    showError("Ingen reminder klar.");
    return;
  }
  downloadFile("reminder-modtagere.csv", reminderData.csv, "text/csv;charset=utf-8;");
});

setInterval(async () => {
  if (currentUser) {
    try {
      await loadAllData();
      renderAll();
      await loadMyAttendanceIntoForm();
    } catch (err) {
      console.error("Auto refresh fejl:", err);
    }
  }
}, 30000);

(async function init() {
  try {
    const hash = window.location.hash || "";
    const isRecoveryFlow = hash.includes("type=recovery") || hash.includes("access_token=");
    if (isRecoveryFlow) {
      $("passwordResetBox").classList.remove("hidden");
      $("authHelperText").textContent = "Vælg et nyt password for din konto.";
    }

    await hydrateCurrentUser();
    await loadAllData();
    renderAll();
    if (currentUser) {
      await loadMyAttendanceIntoForm();
    }
  } catch (err) {
    console.error(err);

    const msg = err?.message || "";
    if (msg.includes("Auth session missing") || msg.includes("session missing")) {
      renderAll();
      return;
    }

    $("setupNotice").textContent =
      msg || "Kunne ikke hente data fra Supabase. Tjek RLS policies, users og members.user_id.";
    $("setupNotice").classList.remove("hidden");
  } finally {
    authBusy = false;
    setLoginBusy(false);
  }
})();

supabase.auth.onAuthStateChange(async (event, session) => {
  try {
    if (event === "SIGNED_OUT" || !session?.user) {
      resetAppStateAfterLogout();
    }
  } catch (err) {
    console.error(err);
  } finally {
    authBusy = false;
    setLoginBusy(false);
  }
});
