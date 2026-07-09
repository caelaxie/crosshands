# Windows fixture

Build on Windows with `dotnet build -c Release`. The interactive runner signs the produced executable, launches it under the dedicated equal-integrity account, and records its digest. UI Automation and final package results—not a successful source build—are release evidence.
