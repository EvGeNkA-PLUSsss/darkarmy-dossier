using System;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Threading;
using System.Windows.Forms;

[assembly: System.Reflection.AssemblyTitle("DarkArmy Dossier")]
[assembly: System.Reflection.AssemblyDescription("DarkArmy Dossier launcher")]
[assembly: System.Reflection.AssemblyVersion("1.1.0.0")]

static class Program
{
    const string URL = "http://127.0.0.1:7561/";
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
    static bool ServerAlive()
    {
        try
        {
            using (HttpClient h = new HttpClient())
            {
                h.Timeout = TimeSpan.FromSeconds(2);
                var r = h.GetAsync(URL + "api/health").Result;
                return r.IsSuccessStatusCode;
            }
        }
        catch { return false; }
    }
    static void OpenAppWindow()
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
                ProcessStartInfo psi = new ProcessStartInfo(b, "--app=" + URL + " --window-size=1440,900");
                psi.UseShellExecute = false;
                Process.Start(psi);
                return;
            }
            catch { }
        }
        Process.Start(URL);
    }
    [STAThread]
    static void Main()
    {
        try
        {
            if (!ServerAlive())
            {
                string dir = FindServerDir();
                if (dir != null)
                {
                    ProcessStartInfo psi = new ProcessStartInfo(FindNode(), "--env-file=.env server.js");
                    psi.WorkingDirectory = dir;
                    psi.UseShellExecute = false;
                    psi.CreateNoWindow = true;
                    psi.WindowStyle = ProcessWindowStyle.Hidden;
                    try { Process.Start(psi); } catch { }
                    for (int i = 0; i < 40 && !ServerAlive(); i++) Thread.Sleep(500);
                }
            }
            OpenAppWindow();
        }
        catch (Exception ex)
        {
            MessageBox.Show("Не удалось запустить DarkArmy Dossier:\n" + ex.Message,
                "DarkArmy Dossier", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
}
