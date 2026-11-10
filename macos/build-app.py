#!/usr/bin/env python3
"""Build a self-contained, locally signed macOS app; never include user data or SSH keys."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import plistlib
import shutil
import subprocess
import tempfile

PROJECT = Path(__file__).resolve().parent.parent
VERSION = '1.4.0'
# Official Node.js LTS archive and its published SHA-256. Pin both for reproducible builds.
NODE = '24.22.2'
HASHES = {
    'arm64': 'aa9549349e47dffaa42dcf95d6e06ade8c4bdafc980979883b88767670df385a',
    'x64': 'd5e336d588c45be0c37dbd52cc29895593009ca4997a77a1fd02815131ed0e52',
}

def run(*args):
    subprocess.run(args, check=True)

def build(output):
    arch = 'arm64' if platform.machine() == 'arm64' else 'x64'
    if output.exists():
        raise SystemExit(f'输出已存在，请选择新的路径：{output}')
    cache = Path.home() / 'Library/Caches/TunnelStudio-build'
    cache.mkdir(parents=True, exist_ok=True)
    archive = cache / f'node-v{NODE}-darwin-{arch}.tar.gz'
    if not archive.exists():
        temporary = archive.with_suffix('.download')
        run('/usr/bin/curl', '-fsSL', '--retry', '2', '--output', str(temporary),
            f'https://nodejs.org/dist/v{NODE}/{archive.name}')
        temporary.rename(archive)
    if hashlib.sha256(archive.read_bytes()).hexdigest() != HASHES[arch]:
        raise SystemExit('Node.js SHA-256 校验失败，停止打包。')
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='tunnel-studio-build-') as temp:
        stage = Path(temp) / 'Tunnel Studio.app'
        contents = stage / 'Contents'
        resources = contents / 'Resources'
        app = resources / 'app'
        runtime = resources / 'runtime'
        executable = contents / 'MacOS'
        for folder in [app, runtime, executable]:
            folder.mkdir(parents=True)
        source = PROJECT / 'portable/TunnelStudio'
        for name in ['server', 'web', 'bin']:
            shutil.copytree(source/name, app/name, ignore=shutil.ignore_patterns('.*'))
        shutil.copy2(source/'package.json', app/'package.json')
        digest = hashlib.sha256()
        for file in sorted(app.rglob('*')):
            if file.is_file():
                digest.update(str(file.relative_to(app)).encode())
                digest.update(file.read_bytes())
        (app/'bin/release.json').write_text(json.dumps({'version': VERSION, 'build': digest.hexdigest()})+'\n')
        run('/usr/bin/tar', '-xzf', str(archive), '-C', temp)
        node_root = Path(temp)/f'node-v{NODE}-darwin-{arch}'
        shutil.copy2(node_root/'bin/node', runtime/'node')
        shutil.copy2(node_root/'LICENSE', runtime/'LICENSE')
        run('/usr/bin/clang', '-O2', '-fobjc-arc', '-framework', 'Foundation', '-framework', 'ServiceManagement', '-mmacosx-version-min=13.5', str(PROJECT/'macos/Launcher.m'), '-o', str(executable/'TunnelStudio'))
        info = {
            'CFBundleExecutable': 'TunnelStudio', 'CFBundleIdentifier': 'com.tunnelstudio.launcher',
            'CFBundleName': 'Tunnel Studio', 'CFBundleDisplayName': 'Tunnel Studio',
            'CFBundlePackageType': 'APPL', 'CFBundleShortVersionString': VERSION,
            'CFBundleVersion': '140', 'LSMinimumSystemVersion': '13.5',
            'LSUIElement': True, 'NSHighResolutionCapable': True,
            'NSHumanReadableCopyright': 'Tunnel Studio · Includes Node.js (see Resources/runtime/LICENSE)',
        }
        (contents/'Info.plist').write_bytes(plistlib.dumps(info))
        (contents/'PkgInfo').write_text('APPL????')
        helper = contents/'Library/LoginItems/Tunnel Studio Login.app/Contents'
        (helper/'MacOS').mkdir(parents=True)
        shutil.copy2(executable/'TunnelStudio', helper/'MacOS/TunnelStudio')
        helper_info = dict(info)
        helper_info.update({'CFBundleIdentifier':'com.tunnelstudio.login', 'CFBundleName':'Tunnel Studio Login', 'CFBundleDisplayName':'Tunnel Studio Login', 'TunnelStudioLoginHelper':True})
        (helper/'Info.plist').write_bytes(plistlib.dumps(helper_info))
        (helper/'PkgInfo').write_text('APPL????')
        for item in stage.rglob('*'):
            if item.is_dir():
                item.chmod(0o755)
            elif item == runtime/'node' or item.name == 'TunnelStudio' or item.suffix == '.sh':
                item.chmod(0o755)
            else:
                item.chmod(0o644)
        # The embedded Node binary retains its official signature; locally sign our launcher/bundle.
        run('/usr/bin/codesign', '--force', '--sign', '-', str(helper.parent))
        run('/usr/bin/codesign', '--force', '--sign', '-', str(stage))
        run('/usr/bin/codesign', '--verify', '--deep', '--strict', str(stage))
        shutil.copytree(stage, output)
    run('/usr/bin/codesign', '--verify', '--deep', '--strict', str(output))
    print(f'已打包：{output}\n架构：{arch}；内置 Node.js {NODE}；不包含 data、私钥或用户配置。')

if __name__ == '__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, default=Path.home()/'Applications/Tunnel Studio.app')
    build(parser.parse_args().output.expanduser().resolve())
