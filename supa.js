/* =========================================================
   Daily Spin - Supabase client bootstrap (PUBLIC config).
   The anon key below is meant to be public - the actual
   protection comes from Row Level Security + the server-side
   functions in db/schema.sql. NEVER put the service_role key
   in the frontend.
   ========================================================= */

"use strict";

(function () {
  window.SUPA_URL = "https://dajkojuhddtjuwwyujvf.supabase.co";
  window.SUPA_ANON =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRhamtvanVoZGR0anV3d3l1anZmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA0MDIzOTEsImV4cCI6MjEwNTk3ODM5MX0.r4lxXSx8SA66Kxy6zvy0nxVm2eB4aWmpf2OcLQ26IBo";

  window.supabase = supabase.createClient(window.SUPA_URL, window.SUPA_ANON, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true
    }
  });

  /* Friendly wording for server error codes so the UI can show
     a message people actually understand. */
  window.apiMessage = function (err) {
    if (!err) return "Something went wrong. Please try again.";
    var msg = (err.message || "").toLowerCase();
    var text = (err.error_description || "").toLowerCase();
    var all = msg + " " + text;

    if (all.indexOf("already_pending") >= 0) return "You already have a withdrawal under review. Please wait for it to finish.";
    if (all.indexOf("insufficient_balance") >= 0) return "Not enough balance for this withdrawal.";
    if (all.indexOf("min_withdrawal") >= 0) return "Minimum withdrawal is $0.40.";
    if (all.indexOf("invalid_account_name") >= 0) return "Please enter the account holder name.";
    if (all.indexOf("invalid_account_no") >= 0) return "Please enter a valid BEP20 wallet address.";
    if (all.indexOf("does not exist") >= 0) return "System database is out of date. Please run the setup script (db/setup_admin.sql) in Supabase.";
    if (all.indexOf("limit_reached") >= 0) return "No spins left for today. Come back tomorrow!";
    if (all.indexOf("no_prize") >= 0) return "Daily earning limit reached for today. Come back tomorrow!";
    if (all.indexOf("name_too_short") >= 0) return "Please enter your full name.";
    if (all.indexOf("email_exists") >= 0 || all.indexOf("already registered") >= 0) return "This email is already registered. Try logging in instead.";
    if (all.indexOf("invalid login credentials") >= 0) return "Wrong email or password.";
    if (all.indexOf("not_authenticated") >= 0) return "Session expired. Please log in again.";
    if (all.indexOf("profile_missing") >= 0) return "Account not ready yet. Please log out and log back in.";
    return msg || "Something went wrong. Please try again.";
  };
})();