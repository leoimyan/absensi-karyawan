(() => {
  const cfg = window.APP_CONFIG || {};
  const $ = (id) => document.getElementById(id);
  const supabaseLib = window.supabase;
  let client, currentUser, currentProfile, stream, photoBlob;

  const show = (id, yes=true) => $(id).classList.toggle("hidden", !yes);
  const msg = (id, text, type="") => { $(id).textContent = text; $(id).className = "message " + type; };
  const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmt = (s) => s ? new Date(s).toLocaleString("id-ID", {dateStyle:"medium",timeStyle:"short"}) : "-";

  function setupClient() {
    if (!supabaseLib || !cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY || cfg.SUPABASE_ANON_KEY.startsWith("GANTI_")) {
      msg("loginMsg", "Konfigurasi Supabase belum diisi. Periksa file config.js.", "error");
      return false;
    }
    client = supabaseLib.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    return true;
  }

  async function loadProfile() {
    const { data, error } = await client.from("profiles")
      .select("id,email,full_name,role").eq("id", currentUser.id).single();
    if (error) throw error;
    currentProfile = data;
    $("userName").textContent = data.full_name || data.email || "Karyawan";
    $("rolePill").textContent = data.role === "admin" ? "Administrator" : "Karyawan";
    show("adminPanel", data.role === "admin");
  }

  async function loadMine() {
    const { data, error } = await client.from("attendance")
      .select("attendance_type,attendance_date,created_at,latitude,longitude,photo_path")
      .eq("user_id", currentUser.id)
      .order("created_at", {ascending:false}).limit(50);
    if (error) { $("myHistory").textContent = error.message; return; }
    $("myHistory").innerHTML = renderTable(data, false);
  }

  async function loadAdmin() {
    if (currentProfile?.role !== "admin") return;
    const { data, error } = await client.from("attendance")
      .select("user_id,attendance_type,attendance_date,created_at,latitude,longitude,photo_path,profiles(full_name,email)")
      .order("created_at", {ascending:false}).limit(200);
    if (error) { $("adminHistory").textContent = "Gagal memuat: " + error.message; return; }
    $("adminHistory").innerHTML = renderTable(data, true);
  }

  function renderTable(rows, admin) {
    if (!rows?.length) return '<p class="muted">Belum ada catatan absensi.</p>';
    return `<table><thead><tr>${admin?'<th>Karyawan</th>':''}<th>Tanggal</th><th>Jenis</th><th>Waktu</th><th>GPS</th><th>Foto</th></tr></thead><tbody>` +
      rows.map(r => {
        const p = r.profiles || {};
        const gps = Number.isFinite(r.latitude) && Number.isFinite(r.longitude)
          ? `<a target="_blank" rel="noopener" href="https://maps.google.com/?q=${r.latitude},${r.longitude}">Lihat peta</a>` : "-";
        return `<tr>${admin?`<td>${escapeHtml(p.full_name || p.email || r.user_id)}</td>`:""}<td>${escapeHtml(r.attendance_date)}</td><td>${r.attendance_type==="masuk"?"Masuk":"Pulang"}</td><td>${escapeHtml(fmt(r.created_at))}</td><td>${gps}</td><td>${escapeHtml(r.photo_path ? "Tersimpan" : "-")}</td></tr>`;
      }).join("") + "</tbody></table>";
  }

  async function startCamera() {
    try {
      stopCamera();
      stream = await navigator.mediaDevices.getUserMedia({video:{facingMode:"user"},audio:false});
      $("video").srcObject = stream;
      show("video"); show("cameraPlaceholder", false); show("photoPreview", false);
      $("video").classList.remove("hidden");
      $("takePhotoBtn").disabled = false;
      photoBlob = null; $("submitAttendanceBtn").disabled = true;
      msg("attendanceMsg", "");
    } catch (e) {
      msg("attendanceMsg", "Kamera tidak dapat dibuka. Izinkan akses kamera dan pastikan aplikasi dibuka melalui HTTPS. " + e.message, "error");
    }
  }

  function stopCamera() {
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  }

  function takePhoto() {
    const video = $("video"), canvas = $("canvas");
    if (!video.videoWidth) { msg("attendanceMsg", "Kamera belum siap. Coba lagi.", "error"); return; }
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0);
    canvas.toBlob(blob => {
      if (!blob) { msg("attendanceMsg", "Gagal mengambil foto.", "error"); return; }
      photoBlob = blob;
      $("photoPreview").src = URL.createObjectURL(blob);
      show("photoPreview"); $("video").classList.add("hidden");
      $("takePhotoBtn").disabled = true; show("retakeBtn");
      $("submitAttendanceBtn").disabled = false;
      stopCamera();
      msg("attendanceMsg", "Foto siap. Tekan Kirim absensi untuk mengambil lokasi GPS.", "success");
    }, "image/jpeg", 0.82);
  }

  async function submitAttendance() {
    if (!photoBlob) { msg("attendanceMsg", "Ambil foto selfie terlebih dahulu.", "error"); return; }
    if (!navigator.geolocation) { msg("attendanceMsg", "Perangkat tidak mendukung GPS/lokasi.", "error"); return; }
    const type = document.querySelector('input[name="attendanceType"]:checked').value;
    $("submitAttendanceBtn").disabled = true;
    msg("attendanceMsg", "Meminta lokasi GPS...", "");
    navigator.geolocation.getCurrentPosition(async pos => {
      try {
        const now = new Date();
        const date = new Intl.DateTimeFormat("en-CA", {timeZone:"Asia/Jakarta"}).format(now);
        const filePath = `${currentUser.id}/${date}/${crypto.randomUUID()}.jpg`;
        msg("attendanceMsg", "Mengunggah foto selfie...", "");
        const { error: upErr } = await client.storage.from("attendance-photos")
          .upload(filePath, photoBlob, {contentType:"image/jpeg", upsert:false});
        if (upErr) throw upErr;
        msg("attendanceMsg", "Menyimpan catatan absensi...", "");
        const { error: insErr } = await client.from("attendance").insert({
          user_id: currentUser.id,
          attendance_type: type,
          attendance_date: date,
          photo_path: filePath,
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          gps_accuracy: pos.coords.accuracy,
          device_time: now.toISOString()
        });
        if (insErr) {
          // Hapus foto jika insert gagal (misalnya absen jenis ini sudah tercatat).
          await client.storage.from("attendance-photos").remove([filePath]);
          throw insErr;
        }
        msg("attendanceMsg", `Absensi ${type} berhasil disimpan. Akurasi GPS ±${Math.round(pos.coords.accuracy)} meter.`, "success");
        photoBlob = null; show("photoPreview", false); show("retakeBtn", false);
        $("submitAttendanceBtn").disabled = true;
        await loadMine(); if (currentProfile.role === "admin") await loadAdmin();
      } catch (e) {
        msg("attendanceMsg", "Absensi gagal: " + (e.message || "Terjadi kesalahan"), "error");
        $("submitAttendanceBtn").disabled = false;
      }
    }, err => {
      const reason = err.code === 1 ? "Izin lokasi ditolak." : err.code === 2 ? "Lokasi tidak tersedia." : "Permintaan lokasi habis waktu.";
      msg("attendanceMsg", reason + " Aktifkan GPS dan izinkan lokasi di Chrome.", "error");
      $("submitAttendanceBtn").disabled = false;
    }, {enableHighAccuracy:true,timeout:20000,maximumAge:0});
  }

  async function enterApp(user) {
    currentUser = user;
    await loadProfile();
    show("loginView", false); show("appView"); show("logoutBtn");
    await loadMine(); if (currentProfile.role === "admin") await loadAdmin();
  }

  $("loginForm").addEventListener("submit", async e => {
    e.preventDefault();
    if (!client && !setupClient()) return;
    msg("loginMsg", "Memeriksa akun...", "");
    const {data,error} = await client.auth.signInWithPassword({email:$("email").value.trim(),password:$("password").value});
    if (error) { msg("loginMsg", error.message, "error"); return; }
    try { await enterApp(data.user); }
    catch (err) { await client.auth.signOut(); msg("loginMsg", "Profil belum tersedia atau gagal dibaca: " + err.message, "error"); }
  });

  $("logoutBtn").addEventListener("click", async () => {
    stopCamera(); await client.auth.signOut(); currentUser=null; currentProfile=null;
    show("appView",false); show("loginView"); show("logoutBtn",false);
  });
  $("startCameraBtn").addEventListener("click", startCamera);
  $("takePhotoBtn").addEventListener("click", takePhoto);
  $("retakeBtn").addEventListener("click", startCamera);
  $("submitAttendanceBtn").addEventListener("click", submitAttendance);
  $("refreshMineBtn").addEventListener("click", loadMine);
  $("refreshAdminBtn").addEventListener("click", loadAdmin);

  if (setupClient()) {
    client.auth.getSession().then(async ({data}) => {
      if (data.session) {
        try { await enterApp(data.session.user); }
        catch(e) { msg("loginMsg", "Silakan login kembali: " + e.message, "error"); }
      }
    });
  }
})();