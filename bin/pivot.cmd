@echo off
rem Pivot launcher for Windows: runs pi with this directory as its agent config.
set "PI_CODING_AGENT_DIR=%~dp0.."
set PIVOT=1
pi %*
