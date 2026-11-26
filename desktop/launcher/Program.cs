using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

[assembly: System.Reflection.AssemblyTitle("DarkArmy Dossier")]
[assembly: System.Reflection.AssemblyDescription("DarkArmy Dossier desktop launcher")]
[assembly: System.Reflection.AssemblyVersion("1.2.0.0")]

static class Program
{
    [STAThread]
    static void Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        try { Application.Run(new LauncherForm()); }
        catch (Exception ex)
        {
            MessageBox.Show("Не удалось запустить DarkArmy Dossier:\n" + ex.Message,
                "DarkArmy Dossier", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
}

static class Launcher
{
    public static string ConfigFile()
    {
        return Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "server.txt");
    }
    public static string ReadServer()
    {
        try
        {
            string p = ConfigFile();
            if (!File.Exists(p)) return "";
            return File.ReadAllText(p).Trim();
        }
        catch { return ""; }
    }
    public static void SaveServer(string url)
    {
        try { File.WriteAllText(ConfigFile(), url + Environment.NewLine); } catch { }
    }
    public static string Normalize(string s)
    {
        s = (s ?? "").Trim();
        if (s.Length == 0) return "";
        if (!s.StartsWith("http://") && !s.StartsWith("https://"))
        {
            bool https = s.IndexOf(":8443", StringComparison.Ordinal) >= 0
                      || s.IndexOf(":443", StringComparison.Ordinal) >= 0
                      || (!s.Contains(":") && !s.StartsWith("127.") && !s.StartsWith("localhost", StringComparison.OrdinalIgnoreCase));
            s = (https ? "https://" : "http://") + s;
        }
        if (!s.EndsWith("/")) s += "/";
        return s;
    }
    public static bool IsLocal(string url)
    {
        try
        {
            Uri u = new Uri(url);
            return u.Host == "127.0.0.1" || u.Host.Equals("localhost", StringComparison.OrdinalIgnoreCase);
        }
        catch { return false; }
    }
    public static string FindServerDir()
    {
        string b = AppDomain.CurrentDomain.BaseDirectory;
        string[] candidates = new string[] {
            b, Path.Combine(b, "DarkArmyDossier"), Path.GetFullPath(Path.Combine(b, "..")),
            Path.GetFullPath(Path.Combine(b, "..", "DarkArmyDossier")),
            @"F:\DarkArmy\DarkArmyDossier"
        };
        foreach (string c in candidates)
        {
            try { if (File.Exists(Path.Combine(c, "server.js"))) return c; } catch { }
        }
        return null;
    }
    public static string FindNode()
    {
        string[] candidates = new string[] {
            @"C:\Program Files\nodejs\node.exe",
            @"C:\Program Files (x86)\nodejs\node.exe"
        };
        foreach (string c in candidates) { try { if (File.Exists(c)) return c; } catch { } }
        return "node.exe";
    }
    public static bool ServerAlive(string url)
    {
        try
        {
            using (HttpClient h = new HttpClient())
            {
                h.Timeout = TimeSpan.FromSeconds(3);
                var r = h.GetAsync(url.TrimEnd('/') + "/api/health").Result;
                return r.IsSuccessStatusCode;
            }
        }
        catch { return false; }
    }
    public static bool StartLocalServer()
    {
        string dir = FindServerDir();
        if (dir == null) return false;
        ProcessStartInfo psi = new ProcessStartInfo(FindNode(), "--env-file=.env server.js");
        psi.WorkingDirectory = dir;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.WindowStyle = ProcessWindowStyle.Hidden;
        try { Process.Start(psi); } catch { return false; }
        for (int i = 0; i < 40; i++)
        {
            if (ServerAlive("http://127.0.0.1:7561/")) return true;
            Thread.Sleep(500);
        }
        return ServerAlive("http://127.0.0.1:7561/");
    }
    public static bool OpenAppWindow(string url)
    {
        string[] browsers = new string[] {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), @"Microsoft\Edge\Application\msedge.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"Microsoft\Edge\Application\msedge.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"Google\Chrome\Application\chrome.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), @"Google\Chrome\Application\chrome.exe")
        };
        foreach (string b in browsers)
        {
            try
            {
                if (!File.Exists(b)) continue;
                ProcessStartInfo psi = new ProcessStartInfo(b, "--app=" + url + " --window-size=1440,900");
                psi.UseShellExecute = false;
                Process.Start(psi);
                return true;
            }
            catch { }
        }
        try { Process.Start(url); return true; } catch { return false; }
    }
    public static bool OpenUrl(string url)
    {
        try { Process.Start(url); return true; } catch { return false; }
    }
    public static string FetchContactUrl(string server)
    {
        try
        {
            using (HttpClient h = new HttpClient())
            {
                h.Timeout = TimeSpan.FromSeconds(3);
                string json = h.GetStringAsync(server.TrimEnd('/') + "/api/public/contact").Result;
                Match m = Regex.Match(json, "\"url\"\\s*:\\s*\"([^\"]+)\"");
                if (m.Success) return m.Groups[1].Value.Replace("\\/", "/");
            }
        }
        catch { }
        return "";
    }
}

class RoundedPanel : Panel
{
    public Color Fill = Color.FromArgb(11, 13, 19);
    public Color Border = Color.FromArgb(44, 50, 68);
    public int Radius = 12;
    public RoundedPanel()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer, true);
    }
    protected override void OnPaint(PaintEventArgs e)
    {
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        Rectangle r = new Rectangle(0, 0, Width - 1, Height - 1);
        using (GraphicsPath path = LauncherForm.RoundRect(r, Radius))
        using (SolidBrush b = new SolidBrush(Fill))
        using (Pen p = new Pen(Border))
        {
            e.Graphics.FillPath(b, path);
            e.Graphics.DrawPath(p, path);
        }
    }
}

class DarkButton : Button
{
    public bool Primary;
    public bool Hover;
    public DarkButton()
    {
        FlatStyle = FlatStyle.Flat;
        FlatAppearance.BorderSize = 0;
        UseVisualStyleBackColor = false;
        BackColor = Color.Transparent;
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer, true);
        Cursor = Cursors.Hand;
    }
    protected override void OnMouseEnter(EventArgs e) { Hover = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { Hover = false; Invalidate(); base.OnMouseLeave(e); }
    protected override void OnPaint(PaintEventArgs e)
    {
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        Rectangle r = new Rectangle(1, 1, Width - 3, Height - 3);
        Color fill = Primary
            ? (Hover ? Color.FromArgb(255, 78, 92) : Color.FromArgb(230, 57, 70))
            : (Hover ? Color.FromArgb(33, 38, 53) : Color.FromArgb(26, 30, 41));
        using (GraphicsPath path = LauncherForm.RoundRect(r, 11))
        using (SolidBrush b = new SolidBrush(fill))
        using (Pen p = new Pen(Primary ? Color.FromArgb(255, 86, 100) : Color.FromArgb(52, 58, 77)))
        {
            e.Graphics.FillPath(b, path);
            e.Graphics.DrawPath(p, path);
        }
        Color textColor = Primary ? Color.White : Color.FromArgb(225, 228, 238);
        TextRenderer.DrawText(e.Graphics, Text, Font, r, textColor,
            TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);
    }
}

class LauncherForm : Form
{
    private TextBox serverBox;
    private Label status;
    private Label contactLabel;
    private string contactUrl = "https://t.me/AgroDeveloper";
    private Label placeholder;
    private DarkButton connectBtn;
    private DarkButton localBtn;

    public LauncherForm()
    {
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(580, 430);
        BackColor = Color.FromArgb(8, 10, 15);
        DoubleBuffered = true;
        Font = new Font("Segoe UI", 9.5f);
        Text = "DarkArmy Dossier";
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
        BuildUi();
        ApplyRoundedRegion();
    }

    [DllImport("user32.dll")]
    private static extern bool ReleaseCapture();
    [DllImport("user32.dll")]
    private static extern IntPtr SendMessage(IntPtr hWnd, int msg, int wParam, int lParam);

    protected override CreateParams CreateParams
    {
        get
        {
            CreateParams cp = base.CreateParams;
            cp.ClassStyle |= 0x20000; // CS_DROPSHADOW
            return cp;
        }
    }

    public static GraphicsPath RoundRect(Rectangle r, int radius)
    {
        GraphicsPath p = new GraphicsPath();
        int d = radius * 2;
        p.AddArc(r.X, r.Y, d, d, 180, 90);
        p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        p.CloseFigure();
        return p;
    }

    private void ApplyRoundedRegion()
    {
        using (GraphicsPath p = RoundRect(new Rectangle(0, 0, Width, Height), 22))
            Region = new Region(p);
    }

    protected override void OnResize(EventArgs e)
    {
        base.OnResize(e);
        ApplyRoundedRegion();
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        Rectangle full = new Rectangle(0, 0, Width, Height);
        using (LinearGradientBrush bg = new LinearGradientBrush(full,
            Color.FromArgb(13, 16, 25), Color.FromArgb(7, 9, 14), 65f))
            e.Graphics.FillRectangle(bg, full);
        using (SolidBrush glow1 = new SolidBrush(Color.FromArgb(32, 230, 57, 70)))
            e.Graphics.FillEllipse(glow1, Width - 270, -150, 380, 380);
        using (SolidBrush glow2 = new SolidBrush(Color.FromArgb(26, 78, 62, 190)))
            e.Graphics.FillEllipse(glow2, -160, Height - 220, 360, 360);
        using (LinearGradientBrush line = new LinearGradientBrush(
            new Rectangle(26, 0, Width - 52, 2),
            Color.FromArgb(0, 230, 57, 70), Color.FromArgb(230, 57, 70), 0f))
            e.Graphics.FillRectangle(line, 26, 0, Width - 52, 2);

        Font brand = new Font("Segoe UI", 17f, FontStyle.Bold);
        Font sub = new Font("Segoe UI", 9f);
        TextRenderer.DrawText(e.Graphics, "DarkArmy", brand, new Point(78, 26), Color.FromArgb(245, 247, 252));
        TextRenderer.DrawText(e.Graphics, "Dossier", brand, new Point(78 + TextRenderer.MeasureText("DarkArmy", brand).Width - 2, 26), Color.FromArgb(230, 57, 70));
        TextRenderer.DrawText(e.Graphics, "Рабочее пространство · подключение", sub, new Point(80, 60), Color.FromArgb(139, 144, 163));
        try
        {
            if (Icon != null) e.Graphics.DrawIcon(new Icon(Icon, 38, 38), 26, 26);
        }
        catch { }
        brand.Dispose();
        sub.Dispose();
    }

    private void BuildUi()
    {
        Label close = new Label();
        close.Text = "\u00d7";
        close.Font = new Font("Segoe UI", 15f);
        close.ForeColor = Color.FromArgb(180, 184, 198);
        close.BackColor = Color.Transparent;
        close.AutoSize = false;
        close.TextAlign = ContentAlignment.MiddleCenter;
        close.SetBounds(Width - 46, 12, 30, 30);
        close.Cursor = Cursors.Hand;
        close.Click += delegate { Close(); };
        Controls.Add(close);

        Label minimize = new Label();
        minimize.Text = "\u2014";
        minimize.Font = new Font("Segoe UI", 10f);
        minimize.ForeColor = Color.FromArgb(180, 184, 198);
        minimize.BackColor = Color.Transparent;
        minimize.AutoSize = false;
        minimize.TextAlign = ContentAlignment.MiddleCenter;
        minimize.SetBounds(Width - 78, 12, 28, 30);
        minimize.Cursor = Cursors.Hand;
        minimize.Click += delegate { WindowState = FormWindowState.Minimized; };
        Controls.Add(minimize);

        Label title = new Label();
        title.Text = "Подключение к серверу";
        title.ForeColor = Color.FromArgb(245, 247, 252);
        title.Font = new Font("Segoe UI", 15f, FontStyle.Bold);
        title.AutoSize = true;
        title.BackColor = Color.Transparent;
        title.Location = new Point(34, 108);
        Controls.Add(title);

        Label hint = new Label();
        hint.Text = "Введите ip:port или полный адрес. Для 8443/443 HTTPS включится сам.";
        hint.ForeColor = Color.FromArgb(145, 151, 172);
        hint.Font = new Font("Segoe UI", 9f);
        hint.AutoSize = true;
        hint.BackColor = Color.Transparent;
        hint.Location = new Point(36, 142);
        Controls.Add(hint);

        RoundedPanel inputWrap = new RoundedPanel();
        inputWrap.SetBounds(34, 180, Width - 68, 52);
        Controls.Add(inputWrap);

        serverBox = new TextBox();
        serverBox.BorderStyle = BorderStyle.None;
        serverBox.BackColor = Color.FromArgb(11, 13, 19);
        serverBox.ForeColor = Color.FromArgb(242, 244, 248);
        serverBox.Font = new Font("Segoe UI", 12f);
        serverBox.SetBounds(16, 15, Width - 68 - 32, 22);
        serverBox.Text = Launcher.ReadServer();
        inputWrap.Controls.Add(serverBox);

        placeholder = new Label();
        placeholder.Text = "147.45.78.20:8443";
        placeholder.ForeColor = Color.FromArgb(94, 100, 120);
        placeholder.BackColor = Color.FromArgb(11, 13, 19);
        placeholder.Font = new Font("Segoe UI", 12f);
        placeholder.AutoSize = true;
        placeholder.Location = new Point(17, 15);
        placeholder.Cursor = Cursors.IBeam;
        placeholder.Click += delegate { serverBox.Focus(); };
        inputWrap.Controls.Add(placeholder);
        placeholder.BringToFront();
        if (serverBox.Text.Length > 0) placeholder.Visible = false;
        serverBox.TextChanged += delegate { placeholder.Visible = serverBox.Text.Length == 0; };
        serverBox.GotFocus += delegate { placeholder.Visible = serverBox.Text.Length == 0; };
        serverBox.LostFocus += delegate { placeholder.Visible = serverBox.Text.Length == 0; };

        status = new Label();
        status.Text = "";
        status.ForeColor = Color.FromArgb(255, 138, 148);
        status.BackColor = Color.Transparent;
        status.Font = new Font("Segoe UI", 9f);
        status.AutoSize = false;
        status.SetBounds(36, 240, Width - 72, 22);
        Controls.Add(status);

        connectBtn = new DarkButton();
        connectBtn.Text = "Подключиться";
        connectBtn.Primary = true;
        connectBtn.Font = new Font("Segoe UI", 10.5f, FontStyle.Bold);
        connectBtn.SetBounds(34, 280, 300, 50);
        connectBtn.Click += delegate { Connect(); };
        Controls.Add(connectBtn);

        localBtn = new DarkButton();
        localBtn.Text = "Локальный сервер";
        localBtn.Font = new Font("Segoe UI", 9.5f, FontStyle.Bold);
        localBtn.SetBounds(346, 280, Width - 380, 50);
        localBtn.Click += delegate { serverBox.Text = "http://127.0.0.1:7561/"; Connect(); };
        Controls.Add(localBtn);

        Label foot = new Label();
        foot.Text = "Адрес сохраняется в server.txt. Сменить сервер можно в любой момент.";
        foot.ForeColor = Color.FromArgb(102, 108, 128);
        foot.Font = new Font("Segoe UI", 8.5f);
        foot.AutoSize = true;
        foot.BackColor = Color.Transparent;
        foot.Location = new Point(36, 350);
        Controls.Add(foot);

        contactLabel = new Label();
        contactLabel.Text = "Доступ и оплата AI — Telegram: @AgroDeveloper";
        contactLabel.ForeColor = Color.FromArgb(116, 122, 143);
        contactLabel.Font = new Font("Segoe UI", 8.5f);
        contactLabel.AutoSize = true;
        contactLabel.BackColor = Color.Transparent;
        contactLabel.Location = new Point(36, 374);
        contactLabel.Cursor = Cursors.Hand;
        contactLabel.Click += delegate { Launcher.OpenUrl(contactUrl); };
        Controls.Add(contactLabel);
        LoadSavedContact();

        MouseDown += delegate(object sender, MouseEventArgs e)
        {
            if (e.Button == MouseButtons.Left)
            {
                ReleaseCapture();
                SendMessage(Handle, 0xA1, 0x2, 0);
            }
        };
        KeyPreview = true;
        KeyDown += delegate(object sender, KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Escape) Close();
            if (e.KeyCode == Keys.Enter) Connect();
        };
    }

    private void LoadSavedContact()
    {
        string saved = Launcher.ReadServer();
        if (saved.Length == 0) return;
        ThreadPool.QueueUserWorkItem(delegate
        {
            string url = Launcher.FetchContactUrl(saved);
            if (url.Length == 0) return;
            try
            {
                BeginInvoke(new Action(delegate
                {
                    contactUrl = url;
                    string handle = "";
                    try
                    {
                        Uri parsed = new Uri(url);
                        handle = parsed.AbsolutePath.Trim('/');
                    }
                    catch { }
                    contactLabel.Text = handle.Length > 0
                        ? "Доступ и оплата AI — Telegram: @" + handle
                        : "Доступ и оплата AI — Telegram";
                }));
            }
            catch { }
        });
    }

    private void Connect()
    {
        string url = Launcher.Normalize(serverBox.Text);
        if (url.Length == 0)
        {
            SetStatus("Введите адрес сервера");
            serverBox.Focus();
            return;
        }
        if (!url.StartsWith("http://") && !url.StartsWith("https://"))
        {
            SetStatus("Адрес должен начинаться с http:// или https://");
            return;
        }
        Launcher.SaveServer(url);
        SetStatus("Подключение...");
        connectBtn.Enabled = false;
        localBtn.Enabled = false;
        try
        {
            if (Launcher.IsLocal(url))
            {
                bool started = Launcher.StartLocalServer();
                if (!started)
                {
                    SetStatus("Локальный сервер не запустился. Проверьте Node.js и server.js.");
                    return;
                }
            }
            if (!Launcher.IsLocal(url) && Launcher.ServerAlive(url))
            {
                // remote server responds — open immediately
            }
            if (!Launcher.OpenAppWindow(url))
            {
                SetStatus("Не найден Edge/Chrome. Откройте адрес вручную: " + url);
                return;
            }
            Close();
        }
        finally
        {
            connectBtn.Enabled = true;
            localBtn.Enabled = true;
        }
    }

    private void SetStatus(string text)
    {
        status.Text = text;
        status.ForeColor = text.StartsWith("Подключение") ? Color.FromArgb(145, 200, 165) : Color.FromArgb(255, 138, 148);
    }
}
