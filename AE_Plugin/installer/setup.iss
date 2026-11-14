; MotionPilot — Inno Setup script (per-user install, no admin).
; Build:  powershell -ExecutionPolicy Bypass -File installer\build.ps1
;         (stages + signs the extension, then compiles this script with /DSrcDir=<signed folder>)
; Output: installer\dist\MotionPilot-Setup-<version>.exe
;
; The installed extension folder must contain EXACTLY the signed files: any extra file
; (an uninstaller, a log, a stale file from an older version) makes After Effects reject
; the signature. Hence the folder is emptied before install, and the uninstaller and the
; user guide live in %LOCALAPPDATA%\MotionPilot instead.

#define AppName "MotionPilot"
#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif
#define ExtId "com.motionpilot"
#ifndef SrcDir
  #define SrcDir "..\com.motionpilot"
#endif
#ifndef GuideFile
  #define GuideFile ""
#endif

[Setup]
AppId={{7D3B1C2E-0AE1-4F0A-9C1B-00AE00A00001}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppName}
AppPublisherURL=https://github.com/jai-surya-r/motionpilot
AppSupportURL=https://github.com/jai-surya-r/motionpilot/issues
AppUpdatesURL=https://github.com/jai-surya-r/motionpilot/releases
VersionInfoVersion={#AppVersion}
VersionInfoDescription={#AppName} Setup - AI motion design panel for Adobe After Effects
VersionInfoProductName={#AppName}
LicenseFile=..\..\LICENSE
DefaultDirName={userappdata}\Adobe\CEP\extensions\{#ExtId}
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=dist
OutputBaseFilename=MotionPilot-Setup-{#AppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName={#AppName} (After Effects panel)
Uninstallable=yes
UninstallFilesDir={localappdata}\{#AppName}\uninstall
CreateUninstallRegKey=yes
SetupLogging=yes

[Tasks]
Name: "compat"; Description: "Compatibility mode - tick only if the panel opens blank in After Effects (turns on Adobe's PlayerDebugMode)"; Flags: unchecked

[Files]
Source: "{#SrcDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion; Excludes: ".debug"
#if GuideFile != ""
Source: "{#GuideFile}"; DestDir: "{localappdata}\{#AppName}"; DestName: "MotionPilot User Guide.html"; Flags: ignoreversion

[Icons]
Name: "{userprograms}\{#AppName} User Guide"; Filename: "{localappdata}\{#AppName}\MotionPilot User Guide.html"

[Run]
Filename: "{localappdata}\{#AppName}\MotionPilot User Guide.html"; Description: "Open the MotionPilot user guide"; Flags: postinstall shellexec skipifsilent nowait
#endif

[Registry]
; Only with the Compatibility-mode task: the signed panel does not need it. Never removed on
; uninstall - other unsigned panels on the machine may rely on it.
Root: HKCU; Subkey: "SOFTWARE\Adobe\CSXS.9";  ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"; Tasks: compat
Root: HKCU; Subkey: "SOFTWARE\Adobe\CSXS.10"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"; Tasks: compat
Root: HKCU; Subkey: "SOFTWARE\Adobe\CSXS.11"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"; Tasks: compat
Root: HKCU; Subkey: "SOFTWARE\Adobe\CSXS.12"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"; Tasks: compat
Root: HKCU; Subkey: "SOFTWARE\Adobe\CSXS.13"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"; Tasks: compat

[Messages]
WelcomeLabel2=This installs the {#AppName} panel for Adobe After Effects (Window > Extensions > {#AppName}) for the current Windows user.%n%nIt checks Claude, ChatGPT (Codex) and Higgsfield: tools that are already installed and signed in are left alone; for the others it asks whether you have them and offers to install and sign in. Tools you skip stay switched off inside the panel.
FinishedLabel=Setup has finished installing {#AppName}.%n%nStart After Effects and open Window > Extensions > {#AppName}.

[Code]
var
  PageClaude, PageGpt, PageHf: TInputOptionWizardPage;
  Summary: String;

{ ---------- helpers ---------- }

function RunHidden(const Cmd: String): Integer;
var R: Integer;
begin
  { cmd /c so PATH lookups and .cmd shims work; output discarded }
  if not Exec(ExpandConstant('{cmd}'), '/d /c ' + Cmd + ' >nul 2>&1', '', SW_HIDE, ewWaitUntilTerminated, R) then R := -1;
  Result := R;
end;

{ True only for a folder that holds a MotionPilot extension (never delete anything else). }
function IsMotionPilotDir(const Dir: String): Boolean;
var M: AnsiString;
begin
  Result := LoadStringFromFile(AddBackslash(Dir) + 'CSXS\manifest.xml', M) and (Pos('com.motionpilot', String(M)) > 0);
end;

function AfterEffectsRunning: Boolean;
begin
  Result := RunHidden('tasklist /FI "IMAGENAME eq AfterFX.exe" | find /I "AfterFX.exe"') = 0;
end;

procedure RunVisible(const Title, Cmd: String);
var R: Integer;
begin
  { a real console window the user can interact with; waits until it closes }
  Exec(ExpandConstant('{cmd}'), '/d /c title ' + Title + ' & echo == ' + Title + ' == & echo. & ' + Cmd +
    ' & echo. & echo Done. Press any key to return to Setup... & pause >nul', '', SW_SHOW, ewWaitUntilTerminated, R);
end;

function HasCmd(const Name: String): Boolean;
begin
  Result := RunHidden('where ' + Name) = 0;
end;

function ClaudeSignedIn: Boolean;
begin
  Result := RunHidden('powershell -NoProfile -Command "if ((claude auth status 2>$null | Out-String) -match ''\"loggedIn\"\s*:\s*true'') { exit 0 } else { exit 1 }"') = 0;
end;

function CodexSignedIn: Boolean;
begin
  Result := RunHidden('codex login status') = 0;
end;

function HfSignedIn: Boolean;
begin
  Result := RunHidden('higgsfield auth token') = 0;
end;

procedure AddSummary(const S: String);
begin
  Summary := Summary + S + #13#10;
  Log('summary: ' + S);
end;

{ One tool: install the CLI if missing (asks), then sign in if needed (asks). }
procedure SetupTool(const Lbl, Cmd, NpmPkg, LoginCmd, LoginHint: String; SignedIn: Boolean; Wanted: Boolean);
var
  Ok: Boolean;
begin
  if WizardSilent then begin
    { unattended: never open console or sign-in windows }
    if HasCmd(Cmd) then AddSummary(Lbl + ' - found') else AddSummary(Lbl + ' - not installed');
    exit;
  end;
  if not Wanted then begin
    AddSummary(Lbl + ' - skipped (its features stay off in the panel)');
    exit;
  end;
  if not HasCmd(Cmd) then begin
    if not HasCmd('npm') then begin
      AddSummary(Lbl + ' - CLI not installed (Node.js/npm missing)');
      exit;
    end;
    { the user already said Yes on this tool's page - install without asking again }
    RunVisible('Installing ' + Lbl + ' CLI', 'npm install -g ' + NpmPkg);
    if not HasCmd(Cmd) then begin
      AddSummary(Lbl + ' - CLI not found yet (if you just installed it, restart Windows or sign in again so PATH updates)');
      exit;
    end;
  end;
  Ok := SignedIn;
  if not Ok then begin
    { open the sign-in window straight away; the hint is shown in its title }
    RunVisible(Lbl + ' sign-in - ' + LoginHint, LoginCmd);
    { re-check after the window closes }
    if Cmd = 'claude' then Ok := ClaudeSignedIn
    else if Cmd = 'codex' then Ok := CodexSignedIn
    else Ok := HfSignedIn;
  end;
  if Ok then AddSummary(Lbl + ' - signed in')
  else AddSummary(Lbl + ' - not signed in yet (run:  ' + LoginCmd + ')');
end;

{ ---------- wizard ---------- }

function InitializeSetup: Boolean;
var R, I: Integer;
begin
  Result := True;
  while AfterEffectsRunning do begin
    if SuppressibleMsgBox('After Effects is running. Please save your work and close it, then click Retry.' + #13#10#13#10 +
         'Click Ignore to ask After Effects to close now, or Cancel to exit Setup.',
         mbConfirmation, MB_ABORTRETRYIGNORE, IDABORT) = IDABORT then begin
      Result := False;
      exit;
    end;
    if not AfterEffectsRunning then break;
    { Ignore: polite close request (After Effects may still ask to save), then wait up to 30 s }
    Exec(ExpandConstant('{cmd}'), '/d /c taskkill /IM AfterFX.exe', '', SW_HIDE, ewWaitUntilTerminated, R);
    for I := 1 to 30 do begin
      if not AfterEffectsRunning then break;
      Sleep(1000);
    end;
  end;
end;

{ Tool state, detected once when the wizard opens: 0 = not installed, 1 = installed but signed out,
  2 = installed and signed in (its page is skipped - nothing to do). }
var
  StClaude, StGpt, StHf: Integer;

function ToolState(const Cmd: String): Integer;
var Signed: Boolean;
begin
  if not HasCmd(Cmd) then begin Result := 0; exit; end;
  if Cmd = 'claude' then Signed := ClaudeSignedIn
  else if Cmd = 'codex' then Signed := CodexSignedIn
  else Signed := HfSignedIn;
  if Signed then Result := 2 else Result := 1;
end;

function MakeToolPage(After: Integer; const Title, Question, What: String; St: Integer; DefaultYes: Boolean): TInputOptionWizardPage;
var P: TInputOptionWizardPage;
begin
  if St = 1 then begin
    P := CreateInputOptionPage(After, Title, Title + ' is installed but not signed in',
      What + ' Yes = Setup opens a sign-in window after installing the panel. No = sign in later.', True, False);
    P.Add('Yes - sign me in');
    P.Add('No - later');
    P.Values[0] := True;
  end else begin
    P := CreateInputOptionPage(After, Title, Question,
      What + ' Yes = Setup installs its command-line tool and offers to sign you in. No = skip it for now.', True, False);
    P.Add('Yes - set it up and sign in');
    P.Add('No - skip');
    if DefaultYes then P.Values[0] := True else P.Values[1] := True;
  end;
  Result := P;
end;

procedure InitializeWizard;
begin
  StClaude := ToolState('claude');
  StGpt := ToolState('codex');
  StHf := ToolState('higgsfield');
  Log(Format('tool state: claude=%d codex=%d higgsfield=%d (0 missing, 1 signed out, 2 ready)', [StClaude, StGpt, StHf]));
  PageClaude := MakeToolPage(wpSelectTasks, 'Claude', 'Do you have Claude?',
    'The panel''s animation brain runs on Claude Code (a Claude Pro/Max/Team subscription or an Anthropic API account).', StClaude, True);
  PageGpt := MakeToolPage(PageClaude.ID, 'ChatGPT', 'Do you have ChatGPT?',
    'ChatGPT (Plus/Pro/Team) powers the GPT models and GPT Image 2 asset generation through the Codex CLI.', StGpt, False);
  PageHf := MakeToolPage(PageGpt.ID, 'Higgsfield', 'Do you have a Higgsfield account?',
    'Higgsfield generates assets (images, video, 3D) through its CLI; without it the Gen pill stays locked.', StHf, False);
end;

{ A tool that is already installed and signed in needs no question. }
function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := ((PageClaude <> nil) and (PageID = PageClaude.ID) and (StClaude = 2)) or
            ((PageGpt <> nil) and (PageID = PageGpt.ID) and (StGpt = 2)) or
            ((PageHf <> nil) and (PageID = PageHf.ID) and (StHf = 2));
end;

procedure SetupOrReport(const Lbl, Cmd, NpmPkg, LoginCmd, LoginHint: String; St: Integer; Wanted: Boolean);
var Signed: Boolean;
begin
  if St = 2 then begin
    AddSummary(Lbl + ' - already installed and signed in');
    exit;
  end;
  if (not Wanted) or WizardSilent then begin
    SetupTool(Lbl, Cmd, NpmPkg, LoginCmd, LoginHint, False, Wanted);
    exit;
  end;
  if Cmd = 'claude' then Signed := ClaudeSignedIn
  else if Cmd = 'codex' then Signed := CodexSignedIn
  else Signed := HfSignedIn;
  SetupTool(Lbl, Cmd, NpmPkg, LoginCmd, LoginHint, Signed, Wanted);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  App: String;
  R: Integer;
begin
  App := ExpandConstant('{app}');
  if CurStep = ssInstall then begin
    { A dev junction/symlink at the target: remove the link only, never its target.
      RemoveDir on a reparse point deletes just the link. }
    if DirExists(App) and (RunHidden('fsutil reparsepoint query "' + App + '"') = 0) then begin
      RemoveDir(App);
      Log('removed reparse point at ' + App);
    end
    else if DirExists(App) and IsMotionPilotDir(App) then begin
      { an older MotionPilot install: remove it so no stale file breaks the signature }
      if DelTree(App, True, True, True) then Log('removed previous install at ' + App)
      else Log('could not fully remove previous install at ' + App);
    end;
  end;
  if CurStep = ssPostInstall then begin
    Summary := '';
    if not HasCmd('node') then begin
      AddSummary('Node.js - not found: install it from https://nodejs.org, then restart After Effects');
      if SuppressibleMsgBox('Node.js was not found. The panel''s After Effects connector runs on Node, and the Claude / Codex / Higgsfield tools install through npm.' + #13#10#13#10 +
                'Open the Node.js download page now? (Install Node.js LTS, then run this Setup again to set up the AI tools.)', mbConfirmation, MB_YESNO, IDNO) = IDYES then
        ShellExec('open', 'https://nodejs.org/en/download', '', '', SW_SHOWNORMAL, ewNoWait, R);
    end;
    SetupOrReport('Claude Code', 'claude', '@anthropic-ai/claude-code', 'claude auth login',
      'a browser tab opens; sign in with your Claude account', StClaude, PageClaude.Values[0]);
    SetupOrReport('ChatGPT (Codex CLI)', 'codex', '@openai/codex', 'codex login',
      'a browser tab opens; sign in with your ChatGPT account', StGpt, PageGpt.Values[0]);
    SetupOrReport('Higgsfield', 'higgsfield', '@higgsfield/cli', 'higgsfield auth login',
      'a browser tab opens for OAuth; approve the CLI', StHf, PageHf.Values[0]);
    SuppressibleMsgBox('{#AppName} is installed.' + #13#10#13#10 + Summary + #13#10 +
      'Start After Effects and open Window > Extensions > {#AppName}.' + #13#10 +
      'Tools you skipped or left signed out stay greyed out in the panel; sign in later with the commands above, then click the status dot in the panel.',
      mbInformation, MB_OK, IDOK);
  end;
end;
