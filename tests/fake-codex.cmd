@echo off
REM A Windows .cmd shim over the fake codex, so the suite exercises the spawn path
REM the SUPPORTED codex install actually takes. `%APPDATA%\npm\codex.cmd` is a batch
REM file, so `spawnCodex` cannot run it under node and goes through cmd.exe with
REM shell:true -- and the pid it gets back is this wrapper, not the worker below.
REM Every kill verification in 0.4.0 therefore checked a proxy. Without this shim
REM CI could not see that, because CODEX_DISPATCH_BIN was always a .mjs.
node "%~dp0fake-codex.mjs" %*
