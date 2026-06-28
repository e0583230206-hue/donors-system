(function () {
  var container = null;

  function getContainer() {
    if (!container) {
      container = document.createElement("div");
      container.className = "toast-container";
      document.body.appendChild(container);
    }
    return container;
  }

  window.showToast = function (message, undoCallback, duration) {
    duration = duration || 5000;
    var c = getContainer();
    var toast = document.createElement("div");
    toast.className = "toast";

    var msg = document.createElement("span");
    msg.textContent = message;
    toast.appendChild(msg);

    var timer;

    function removeToast() {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }

    if (undoCallback) {
      var btn = document.createElement("button");
      btn.className = "toast-undo";
      btn.textContent = "בטל";
      btn.addEventListener("click", function () {
        clearTimeout(timer);
        undoCallback();
        removeToast();
      });
      toast.appendChild(btn);
    }

    c.appendChild(toast);
    timer = setTimeout(removeToast, duration);
  };
})();
