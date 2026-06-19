@echo off
call "C:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvarsall.bat" x64
cl.exe /EHsc /W3 /O2 /MT main.cpp /link advapi32.lib tdh.lib
