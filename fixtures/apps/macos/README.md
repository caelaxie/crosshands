# macOS fixture

Build with `swift build -c release`. The runner launches the executable from the signed fixture bundle with the protocol arguments in `../PROTOCOL.md`; signing the fixture and recording its digest are runner responsibilities. A local source build is not release evidence.
