// menus_settings.js - Handles menus and settings

btnSettings.addEventListener("click", () => {
  settingsModal.style.display = "flex";
  checkMagnetic.checked = magneticSnapping;
  checkPauseAtPlayhead.checked = pauseAtPlayhead;
});
closeSettingsBtn.addEventListener("click", () => {
  settingsModal.style.display = "none";
});
checkMagnetic.addEventListener("change", (e) => {
  magneticSnapping = e.target.checked;
});
checkPauseAtPlayhead.addEventListener("change", (e) => {
  pauseAtPlayhead = e.target.checked;
});

btnHelp.addEventListener("click", () => {
  helpModal.style.display = "flex";
});
closeHelpBtn.addEventListener("click", () => {
  helpModal.style.display = "none";
});

window.addEventListener("click", (e) => {
  if (e.target === settingsModal) settingsModal.style.display = "none";
  if (e.target === helpModal) helpModal.style.display = "none";
});
