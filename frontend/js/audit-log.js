const AuditLog = (function () {
  const actionLabels = {
    create: "הוספה",
    update: "עריכה",
    delete: "מחיקה",
    approve: "אישור",
    cancel: "ביטול",
    complete: "סגירה",
    payment: "תשלום",
    import: "ייבוא",
    status: "שינוי סטטוס",
  };

  const entityTypeLabels = {
    donor: "תורם",
    donation: "תרומה/חוב",
    reminder: "תזכורת",
    callback: "הודעה לחזרה",
    worker: "עובד",
    task: "משימה",
    approval: "אישור חיוב",
    system: "מערכת",
  };

  function getCurrentUserSafe() {
    if (typeof getCurrentUser === "function") {
      const currentUser = getCurrentUser();
      if (currentUser) return currentUser;
    }

    return {
      id: "",
      name: "משתמש לא ידוע",
      role: "",
    };
  }

  function getIsraelDateTime(date) {
    return date.toLocaleString("he-IL", {
      timeZone: "Asia/Jerusalem",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }

  function getHebrewDate(date) {
    return window.HebrewDate
      ? window.HebrewDate.getHebrewDateText(date)
      : date.toLocaleDateString("he-IL-u-ca-hebrew", {
          day: "numeric",
          month: "long",
          year: "numeric",
          timeZone: "Asia/Jerusalem",
        });
  }

  function getWeekday(date) {
    return window.HebrewDate
      ? window.HebrewDate.getHebrewWeekday(date)
      : date.toLocaleDateString("he-IL", {
          weekday: "long",
          timeZone: "Asia/Jerusalem",
        });
  }

  function buildText(log) {
    const parts = [
      log.actionLabel,
      log.entityTypeLabel,
      log.entityName || log.entityId || "",
      log.details || "",
    ];

    return parts
      .filter(function (part) {
        return part !== "";
      })
      .join(" | ");
  }

  function record(data) {
    const now = new Date();
    const user = getCurrentUserSafe();

    const log = {
      id: Date.now(),
      createdAt: now.toISOString(),
      israelDateTime: getIsraelDateTime(now),
      hebrewDate: getHebrewDate(now),
      weekday: getWeekday(now),
      user: {
        id: user.id || "",
        name: user.name || "משתמש לא ידוע",
        role: user.role || "",
      },
      action: data.action || "system",
      actionLabel: actionLabels[data.action] || data.action || "פעולה",
      entityType: data.entityType || "system",
      entityTypeLabel:
        entityTypeLabels[data.entityType] || data.entityType || "מערכת",
      entityId: data.entityId || "",
      entityName: data.entityName || "",
      details: data.details || "",
      changes: Array.isArray(data.changes) ? data.changes : [],
      text: "",
      date: now.toISOString(),
    };

    log.text = buildText(log);

    const logs = Database.get("logs");
    logs.push(log);
    Database.save("logs", logs);

    return log;
  }

  return {
    record: record,
  };
})();
