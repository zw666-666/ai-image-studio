; image生图助手 安装脚本
[Setup]
AppId={{8F3A1B2C-6D5E-4F7A-9B8C-2E4D6F7A8B9C}
AppName=image生图助手
AppVersion=1.0
AppVerName=image生图助手 1.0
AppPublisher=image生图助手
DefaultDirName={autopf}\image生图助手
DefaultGroupName=image生图助手
DisableProgramGroupPage=yes
OutputDir=D:\自制小工具\生图工具
OutputBaseFilename=image生图助手安装包
SetupIconFile=D:\自制小工具\生图工具\app_icon.ico
UninstallDisplayIcon={app}\image生图助手.exe
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=admin

[Languages]
Name: "chinesesimp"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[Files]
Source: "D:\自制小工具\生图工具\dist\image生图助手\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\image生图助手"; Filename: "{app}\image生图助手.exe"; WorkingDir: "{app}"
Name: "{autodesktop}\image生图助手"; Filename: "{app}\image生图助手.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加任务:"; Flags: unchecked

[Run]
Filename: "{app}\image生图助手.exe"; Description: "立即运行 image生图助手"; Flags: nowait postinstall skipifsilent