#!/usr/bin/env python3
"""Сборка release/DarkArmyDossier.apk без Gradle (aapt2 + javac + d8 + apksigner).

Требуется Android SDK (build-tools 35/36, platform android-34+) и JDK 17+.
Запуск: python android/build.py
Переменные: ANDROID_SDK_ROOT / ANDROID_HOME, JAVA_HOME (иначе ищет стандартные пути).
"""
import os, subprocess, shutil, sys, zipfile, glob

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AND = os.path.join(ROOT, 'android')
SDK = os.environ.get('ANDROID_SDK_ROOT') or os.environ.get('ANDROID_HOME') or \
      os.path.expandvars(r'%LOCALAPPDATA%\Android\Sdk')
JAVA_HOME = os.environ.get('JAVA_HOME') or r'C:\Program Files\Java\jdk-21.0.11'
if not os.path.exists(JAVA_HOME):
    sys.exit('Укажите JAVA_HOME (JDK 17+)')

def pick_build_tools():
    dirs = []
    for d in glob.glob(os.path.join(SDK, 'build-tools', '*')):
        try: dirs.append((tuple(int(x) for x in os.path.basename(d).split('.')), d))
        except: pass
    return sorted(dirs)[-1][1] if dirs else None
def pick_platform():
    dirs = []
    for d in glob.glob(os.path.join(SDK, 'platforms', 'android-*')):
        try: dirs.append((int(os.path.basename(d).split('-')[-1]), d))
        except: pass
    return sorted(dirs)[-1][1] if dirs else None

BT = pick_build_tools(); PLATFORM_DIR = pick_platform()
if not BT: sys.exit('Android build-tools не найдены в ' + SDK)
if not PLATFORM_DIR: sys.exit('Android platform не найдена в ' + SDK)
PLATFORM = os.path.join(PLATFORM_DIR, 'android.jar')
env = os.environ.copy(); env['JAVA_HOME'] = JAVA_HOME
env['PATH'] = os.path.join(JAVA_HOME, 'bin') + os.pathsep + env.get('PATH', '')

def run(cmd, check=True):
    print('>', ' '.join(os.path.basename(x) if i == 0 else x for i, x in enumerate(cmd)))
    p = subprocess.run(cmd, cwd=AND, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    if p.stdout.strip(): print(p.stdout[-3000:])
    if check and p.returncode != 0: sys.exit('FAILED: ' + cmd[0])
    return p

build = os.path.join(AND, 'build')
shutil.rmtree(build, ignore_errors=True)
for d in ('classes', 'dex', 'out', 'res'):
    os.makedirs(os.path.join(build, d), exist_ok=True)
# ресурсы: иконки
src_icon = os.path.join(ROOT, 'public', 'icons', 'icon-192.png')
for density in ('xhdpi', 'xxhdpi', 'xxxhdpi'):
    d = os.path.join(AND, 'res', 'mipmap-' + density); os.makedirs(d, exist_ok=True)
    shutil.copy(src_icon, os.path.join(d, 'ic_launcher.png'))
run([os.path.join(BT, 'aapt2.exe' if os.name == 'nt' else 'aapt2'), 'compile', '--dir', os.path.join(AND, 'res'), '-o', os.path.join(build, 'res.zip')])
run([os.path.join(BT, 'aapt2.exe' if os.name == 'nt' else 'aapt2'), 'link', '-o', os.path.join(build, 'base.apk'),
     '-I', PLATFORM, '--manifest', os.path.join(AND, 'AndroidManifest.xml'), '-R', os.path.join(build, 'res.zip'),
     '--java', os.path.join(build, 'out'), '--auto-add-overlay'])
run([os.path.join(JAVA_HOME, 'bin', 'javac.exe' if os.name == 'nt' else 'javac'), '-encoding', 'UTF-8', '-source', '8', '-target', '8',
     '-bootclasspath', PLATFORM, '-d', os.path.join(build, 'classes'),
     os.path.join(AND, 'src', 'com', 'darkarmy', 'dossier', 'MainActivity.java')])
class_dir = os.path.join(build, 'classes', 'com', 'darkarmy', 'dossier')
class_files = sorted(glob.glob(os.path.join(class_dir, '*.class')))
if not class_files:
    sys.exit('Нет скомпилированных классов в ' + class_dir)
run([os.path.join(BT, 'd8.bat' if os.name == 'nt' else 'd8'), '--release', '--min-api', '24', '--lib', PLATFORM,
     '--output', os.path.join(build, 'dex')] + class_files)
with zipfile.ZipFile(os.path.join(build, 'base.apk'), 'a', zipfile.ZIP_DEFLATED) as z:
    z.write(os.path.join(build, 'dex', 'classes.dex'), 'classes.dex')
run([os.path.join(BT, 'zipalign.exe' if os.name == 'nt' else 'zipalign'), '-f', '-p', '4',
     os.path.join(build, 'base.apk'), os.path.join(build, 'aligned.apk')])
ks = os.path.join(AND, 'debug.keystore')
if not os.path.exists(ks):
    run([os.path.join(JAVA_HOME, 'bin', 'keytool.exe' if os.name == 'nt' else 'keytool'), '-genkeypair', '-keystore', ks,
         '-alias', 'androiddebugkey', '-storepass', 'android', '-keypass', 'android',
         '-dname', 'CN=Android Debug,O=Android,C=US', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000'])
out = os.path.join(ROOT, 'release', 'DarkArmyDossier.apk'); os.makedirs(os.path.dirname(out), exist_ok=True)
run([os.path.join(BT, 'apksigner.bat' if os.name == 'nt' else 'apksigner'), 'sign', '--ks', ks,
     '--ks-key-alias', 'androiddebugkey', '--ks-pass', 'pass:android', '--key-pass', 'pass:android',
     '--out', out, os.path.join(build, 'aligned.apk')])
print('APK OK:', out, os.path.getsize(out), 'bytes')
