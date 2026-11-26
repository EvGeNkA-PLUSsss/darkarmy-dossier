using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net.Http;
using System.Threading;
using System.Windows.Forms;

[assembly: System.Reflection.AssemblyTitle("DarkArmy Dossier")]
[assembly: System.Reflection.AssemblyDescription("DarkArmy Dossier launcher / server connector")]
[assembly: System.Reflection.AssemblyVersion("1.1.1.0")]

static class Program
{
    static string ConfigFile()
    {
        return Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "server.txt");
    }
    static string ReadServer()
    {
        try
        {
            string p = ConfigFile();
            if (!File.Exists(p)) return "";
            return File.ReadAllText(p).Trim();
        }
        catch { return ""; }
    }
    static void SaveServer(string url)
    {
        try { File.WriteAllText(ConfigFile(), url + Environment.NewLine); } catch { }
    }
    static string Normalize(string s)
    {
        s = (s ?? "").Trim();
        if (s.Length == 0) return "";
        if (!s.StartsWith("http://") && !s.StartsWith("https://")) s = "http://" + s;
        if (!s.EndsWith("/")) s += "/";
        return s;
    }
    static bool IsLocal(string url)
    {
        try
        {
            Uri u = new Uri(url);
            return u.Host == "127.0.0.1" || u.Host.Equals("localhost", StringComparison.OrdinalIgnoreCase);
        }
        catch { return false; }
    }
    static string FindServerDir()
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
    static string FindNode()
    {
        string[] candidates = new string[] {
            @"C:\Program Files\nodejs\node.exe",
            @"C:\Program Files (x86)\nodejs\node.exe"
        };
        foreach (string c in candidates) { try { if (File.Exists(c)) return c; } catch { } }
        return "node.exe";
    }
    static bool ServerAlive(string url)
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
    static void StartLocalServer()
    {
        string dir = FindServerDir();
        if (dir == null) return;
        ProcessStartInfo psi = new ProcessStartInfo(FindNode(), "--env-file=.env server.js");
        psi.WorkingDirectory = dir;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.WindowStyle = ProcessWindowStyle.Hidden;
        try { Process.Start(psi); } catch { }
        for (int i = 0; i < 40; i++)
        {
            if (ServerAlive("http://127.0.0.1:7561/")) return;
            Thread.Sleep(500);
        }
    }
    static void OpenAppWindow(string url)
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
                return;
            }
            catch { }
        }
        Process.Start(url);
    }
    static string AskServer(string current)
    {
        using (Form f = new Form())
        {
            f.Text = "DarkArmy Dossier — подключение";
            f.FormBorderStyle = FormBorderStyle.FixedDialog;
            f.StartPosition = FormStartPosition.CenterScreen;
            f.MinimizeBox = false;
            f.MaximizeBox = false;
            f.ClientSize = new Size(520, 190);
            f.BackColor = Color.FromArgb(16, 18, 24);
            f.ForeColor = Color.FromArgb(235, 238, 245);
            Label title = new Label();
            title.Text = "Введите адрес сервера";
            title.Font = new Font("Segoe UI", 13, FontStyle.Bold);
            title.AutoSize = true; title.Location = new Point(22, 18);
            Label hint = new Label();
            hint.Text = "Например: 147.45.78.20:8443 или https://dossier.example.com\nОставьте пустым для локального сервера.";
            hint.ForeColor = Color.FromArgb(160, 168, 184);
            hint.AutoSize = true; hint.Location = new Point(22, 48);
            TextBox input = new TextBox();
            input.Text = current;
            input.Location = new Point(22, 94); input.Width = 476;
            input.Font = new Font("Segoe UI", 11);
            Button ok = new Button();
            ok.Text = "Подключиться";
            ok.DialogResult = DialogResult.OK;
            ok.Location = new Point(342, 138); ok.Width = 156;
            Button local = new Button();
            local.Text = "Локальный сервер";
            local.DialogResult = DialogResult.No;
            local.Location = new Point(22, 138); local.Width = 150;
            f.Controls.Add(title); f.Controls.Add(hint); f.Controls.Add(input); f.Controls.Add(ok); f.Controls.Add(local);
            f.AcceptButton = ok;
            DialogResult r = f.ShowDialog();
            if (r == DialogResult.Cancel) return null;
            if (r == DialogResult.No) return "http://127.0.0.1:7561/";
            return Normalize(input.Text);
        }
    }
    [STAThread]
    static void Main(string[] args)
    {
        try
        {
            string url = ReadServer();
            bool setup = false;
            foreach (string a in args) if (a == "--setup" || a == "-s") setup = true;
            if (url.Length == 0 || setup)
            {
                url = AskServer(url);
                if (url == null) return;
                SaveServer(url);
            }
            url = Normalize(url);
            if (IsLocal(url) && !ServerAlive(url)) StartLocalServer();
            if (!ServerAlive(url))
            {
                DialogResult again = MessageBox.Show(
                    "Сервер " + url + " не отвечает.\n\nОткрыть настройки подключения?",
                    "DarkArmy Dossier", MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
                if (again == DialogResult.Yes)
                {
                    url = AskServer(url);
                    if (url == null) return;
                    SaveServer(url);
                }
            }
            OpenAppWindow(url);
        }
        catch (Exception ex)
        {
            MessageBox.Show("Не удалось запустить DarkArmy Dossier:\n" + ex.Message,
                "DarkArmy Dossier", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
}
