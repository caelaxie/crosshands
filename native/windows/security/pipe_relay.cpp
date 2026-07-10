#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <sddl.h>

#include <atomic>
#include <cstdint>
#include <cwchar>
#include <cstdio>
#include <map>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace {

constexpr std::uint32_t kMagic = 0x53504858;  // XHPS on little-endian Windows.
constexpr std::uint16_t kVersion = 1;
constexpr std::uint32_t kMaxPayloadBytes = 4 * 1024 * 1024;
constexpr std::uint16_t kOpen = 1;
constexpr std::uint16_t kData = 2;
constexpr std::uint16_t kClose = 3;
constexpr std::uint16_t kReady = 5;
constexpr std::uint16_t kShutdown = 6;

#pragma pack(push, 1)
struct RecordHeader {
  std::uint32_t magic;
  std::uint16_t version;
  std::uint16_t type;
  std::uint64_t connection_id;
  std::uint32_t payload_length;
};
#pragma pack(pop)

static_assert(sizeof(RecordHeader) == 20, "relay header layout changed");

struct TokenIdentity {
  std::wstring user_sid;
  std::wstring logon_sid;
  LUID authentication_id{};
  DWORD integrity_rid = 0;
};

struct PeerIdentity : TokenIdentity {
  DWORD pid = 0;
  DWORD windows_session_id = 0;
  std::wstring executable_path;
  std::string process_started_at;
};

std::mutex g_stdout_mutex;
std::mutex g_clients_mutex;
std::map<std::uint64_t, HANDLE> g_clients;
std::atomic<bool> g_stopping{false};
std::atomic<std::uint64_t> g_next_connection{1};
std::wstring g_pipe_name;

void fail(const char* message) {
  std::fprintf(stderr, "crosshands-pipe-relay: %s (win32=%lu)\n", message,
               static_cast<unsigned long>(GetLastError()));
  ExitProcess(2);
}

bool write_all(HANDLE handle, const void* data, DWORD length) {
  const auto* cursor = static_cast<const BYTE*>(data);
  DWORD remaining = length;
  while (remaining > 0) {
    DWORD written = 0;
    if (!WriteFile(handle, cursor, remaining, &written, nullptr) || written == 0) return false;
    cursor += written;
    remaining -= written;
  }
  return true;
}

bool read_all(HANDLE handle, void* data, DWORD length) {
  auto* cursor = static_cast<BYTE*>(data);
  DWORD remaining = length;
  while (remaining > 0) {
    DWORD read = 0;
    if (!ReadFile(handle, cursor, remaining, &read, nullptr) || read == 0) return false;
    cursor += read;
    remaining -= read;
  }
  return true;
}

void send_record(std::uint16_t type, std::uint64_t connection_id,
                 const void* payload = nullptr, std::uint32_t payload_length = 0) {
  RecordHeader header{kMagic, kVersion, type, connection_id, payload_length};
  std::lock_guard<std::mutex> lock(g_stdout_mutex);
  HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
  if (!write_all(output, &header, static_cast<DWORD>(sizeof(header)))) {
    g_stopping = true;
    return;
  }
  if (payload_length > 0 && !write_all(output, payload, payload_length)) g_stopping = true;
}

std::vector<BYTE> token_information(HANDLE token, TOKEN_INFORMATION_CLASS kind) {
  DWORD bytes = 0;
  GetTokenInformation(token, kind, nullptr, 0, &bytes);
  if (bytes == 0 || GetLastError() != ERROR_INSUFFICIENT_BUFFER) fail("token query size failed");
  std::vector<BYTE> buffer(bytes);
  if (!GetTokenInformation(token, kind, buffer.data(), bytes, &bytes)) fail("token query failed");
  return buffer;
}

std::wstring sid_string(PSID sid) {
  LPWSTR text = nullptr;
  if (!IsValidSid(sid) || !ConvertSidToStringSidW(sid, &text)) fail("SID conversion failed");
  std::wstring result(text);
  LocalFree(text);
  return result;
}

TokenIdentity query_identity(HANDLE token) {
  TokenIdentity identity;
  const auto user_bytes = token_information(token, TokenUser);
  const auto* user = reinterpret_cast<const TOKEN_USER*>(user_bytes.data());
  identity.user_sid = sid_string(user->User.Sid);

  const auto groups_bytes = token_information(token, TokenGroups);
  const auto* groups = reinterpret_cast<const TOKEN_GROUPS*>(groups_bytes.data());
  for (DWORD index = 0; index < groups->GroupCount; ++index) {
    if ((groups->Groups[index].Attributes & SE_GROUP_LOGON_ID) == SE_GROUP_LOGON_ID) {
      identity.logon_sid = sid_string(groups->Groups[index].Sid);
      break;
    }
  }
  if (identity.logon_sid.empty()) fail("token has no logon SID");

  const auto statistics_bytes = token_information(token, TokenStatistics);
  const auto* statistics = reinterpret_cast<const TOKEN_STATISTICS*>(statistics_bytes.data());
  identity.authentication_id = statistics->AuthenticationId;

  const auto integrity_bytes = token_information(token, TokenIntegrityLevel);
  const auto* integrity = reinterpret_cast<const TOKEN_MANDATORY_LABEL*>(integrity_bytes.data());
  const DWORD count = *GetSidSubAuthorityCount(integrity->Label.Sid);
  if (count == 0) fail("token has no integrity RID");
  identity.integrity_rid = *GetSidSubAuthority(integrity->Label.Sid, count - 1);
  return identity;
}

TokenIdentity process_identity(DWORD pid) {
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (process == nullptr) fail("broker process cannot be opened");
  HANDLE token = nullptr;
  if (!OpenProcessToken(process, TOKEN_QUERY, &token)) {
    CloseHandle(process);
    fail("broker token cannot be opened");
  }
  TokenIdentity result = query_identity(token);
  CloseHandle(token);
  CloseHandle(process);
  return result;
}

bool same_luid(const LUID& left, const LUID& right) {
  return left.HighPart == right.HighPart && left.LowPart == right.LowPart;
}

std::string narrow_json(const std::wstring& input) {
  if (input.empty()) return {};
  const int required = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, input.data(),
                                            static_cast<int>(input.size()), nullptr, 0, nullptr,
                                            nullptr);
  if (required <= 0) fail("UTF-8 conversion failed");
  std::string result(static_cast<std::size_t>(required), '\0');
  if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, input.data(),
                          static_cast<int>(input.size()), result.data(), required, nullptr,
                          nullptr) != required) {
    fail("UTF-8 conversion failed");
  }
  return result;
}

std::string json_escape(const std::string& input) {
  std::string output;
  output.reserve(input.size());
  for (const unsigned char value : input) {
    switch (value) {
      case '\\': output += "\\\\"; break;
      case '"': output += "\\\""; break;
      case '\b': output += "\\b"; break;
      case '\f': output += "\\f"; break;
      case '\n': output += "\\n"; break;
      case '\r': output += "\\r"; break;
      case '\t': output += "\\t"; break;
      default:
        if (value < 0x20) {
          char escaped[7]{};
          std::snprintf(escaped, sizeof(escaped), "\\u%04x", static_cast<unsigned>(value));
          output += escaped;
        } else {
          output += static_cast<char>(value);
        }
    }
  }
  return output;
}

std::string filetime_iso8601(const FILETIME& filetime) {
  SYSTEMTIME utc{};
  if (!FileTimeToSystemTime(&filetime, &utc)) fail("process time conversion failed");
  char result[32]{};
  std::snprintf(result, sizeof(result), "%04u-%02u-%02uT%02u:%02u:%02u.%03uZ",
                static_cast<unsigned>(utc.wYear), static_cast<unsigned>(utc.wMonth),
                static_cast<unsigned>(utc.wDay), static_cast<unsigned>(utc.wHour),
                static_cast<unsigned>(utc.wMinute), static_cast<unsigned>(utc.wSecond),
                static_cast<unsigned>(utc.wMilliseconds));
  return result;
}

bool inspect_peer(HANDLE pipe, const TokenIdentity& expected, DWORD expected_windows_session,
                  PeerIdentity* output) {
  DWORD pid = 0;
  DWORD pipe_session = 0;
  if (!GetNamedPipeClientProcessId(pipe, &pid) || pid == 0) return false;
  if (!GetNamedPipeClientSessionId(pipe, &pipe_session)) return false;
  if (pipe_session != expected_windows_session) return false;

  if (!ImpersonateNamedPipeClient(pipe)) return false;
  HANDLE token = nullptr;
  const BOOL opened = OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, TRUE, &token);
  TokenIdentity client;
  if (opened) client = query_identity(token);
  if (token != nullptr) CloseHandle(token);
  RevertToSelf();
  if (!opened || client.user_sid != expected.user_sid || client.logon_sid != expected.logon_sid ||
      !same_luid(client.authentication_id, expected.authentication_id) ||
      client.integrity_rid != expected.integrity_rid) {
    return false;
  }

  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (process == nullptr) return false;
  std::vector<wchar_t> path(32768);
  DWORD path_length = static_cast<DWORD>(path.size());
  FILETIME created{}, exited{}, kernel{}, user{};
  const BOOL path_ok = QueryFullProcessImageNameW(process, 0, path.data(), &path_length);
  const BOOL time_ok = GetProcessTimes(process, &created, &exited, &kernel, &user);
  CloseHandle(process);
  if (!path_ok || path_length == 0 || !time_ok) return false;

  static_cast<TokenIdentity&>(*output) = client;
  output->pid = pid;
  output->windows_session_id = pipe_session;
  output->executable_path.assign(path.data(), path_length);
  output->process_started_at = filetime_iso8601(created);
  return true;
}

std::string peer_json(const PeerIdentity& peer) {
  const auto luid = std::to_string(peer.authentication_id.HighPart) + ":" +
                    std::to_string(peer.authentication_id.LowPart);
  return "{\"pid\":" + std::to_string(peer.pid) + ",\"userSid\":\"" +
         json_escape(narrow_json(peer.user_sid)) + "\",\"logonSid\":\"" +
         json_escape(narrow_json(peer.logon_sid)) + "\",\"logonSessionId\":\"" + luid +
         "\",\"integrityRid\":" + std::to_string(peer.integrity_rid) +
         ",\"windowsSessionId\":" + std::to_string(peer.windows_session_id) +
         ",\"processStartedAt\":\"" + peer.process_started_at +
         "\",\"executablePath\":\"" + json_escape(narrow_json(peer.executable_path)) +
         "\",\"remote\":false}";
}

void close_client(std::uint64_t id, HANDLE pipe) {
  {
    std::lock_guard<std::mutex> lock(g_clients_mutex);
    const auto found = g_clients.find(id);
    if (found != g_clients.end() && found->second == pipe) g_clients.erase(found);
  }
  FlushFileBuffers(pipe);
  DisconnectNamedPipe(pipe);
  CloseHandle(pipe);
  send_record(kClose, id);
}

void client_reader(std::uint64_t id, HANDLE pipe) {
  std::vector<BYTE> buffer(64 * 1024);
  while (!g_stopping) {
    DWORD bytes = 0;
    if (!ReadFile(pipe, buffer.data(), static_cast<DWORD>(buffer.size()), &bytes, nullptr) ||
        bytes == 0) {
      break;
    }
    send_record(kData, id, buffer.data(), bytes);
  }
  close_client(id, pipe);
}

void stdin_dispatcher() {
  HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
  while (!g_stopping) {
    RecordHeader header{};
    if (!read_all(input, &header, static_cast<DWORD>(sizeof(header)))) break;
    if (header.magic != kMagic || header.version != kVersion ||
        header.payload_length > kMaxPayloadBytes) {
      g_stopping = true;
      break;
    }
    std::vector<BYTE> payload(header.payload_length);
    if (header.payload_length > 0 && !read_all(input, payload.data(), header.payload_length)) break;
    if (header.type == kShutdown) {
      g_stopping = true;
      break;
    }
    HANDLE pipe = nullptr;
    {
      std::lock_guard<std::mutex> lock(g_clients_mutex);
      const auto found = g_clients.find(header.connection_id);
      if (found != g_clients.end()) pipe = found->second;
    }
    if (pipe == nullptr) continue;
    if (header.type == kData && !write_all(pipe, payload.data(), header.payload_length)) {
      DisconnectNamedPipe(pipe);
    } else if (header.type == kClose) {
      {
        std::lock_guard<std::mutex> lock(g_clients_mutex);
        g_clients.erase(header.connection_id);
      }
      DisconnectNamedPipe(pipe);
    }
  }
  g_stopping = true;
  // Wake a synchronous ConnectNamedPipe in the main thread so shutdown does
  // not depend on terminating the helper.
  HANDLE wake = CreateFileW(g_pipe_name.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr,
                            OPEN_EXISTING, 0, nullptr);
  if (wake != INVALID_HANDLE_VALUE) CloseHandle(wake);
  std::lock_guard<std::mutex> lock(g_clients_mutex);
  for (const auto& client : g_clients) DisconnectNamedPipe(client.second);
}

std::wstring argument_value(int argc, wchar_t** argv, const wchar_t* name) {
  for (int index = 1; index + 1 < argc; ++index) {
    if (std::wcscmp(argv[index], name) == 0) return argv[index + 1];
  }
  return {};
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
  const std::wstring pipe_name = argument_value(argc, argv, L"--pipe");
  const std::wstring broker_pid_text = argument_value(argc, argv, L"--broker-pid");
  if (pipe_name.rfind(L"\\\\.\\pipe\\crosshands-", 0) != 0 || broker_pid_text.empty()) {
    std::fprintf(stderr, "crosshands-pipe-relay: invalid arguments\n");
    return 2;
  }
  g_pipe_name = pipe_name;
  const DWORD broker_pid = static_cast<DWORD>(std::wcstoul(broker_pid_text.c_str(), nullptr, 10));
  if (broker_pid == 0) return 2;

  HANDLE self_token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &self_token)) fail("self token failed");
  const TokenIdentity expected = query_identity(self_token);
  CloseHandle(self_token);
  const TokenIdentity broker = process_identity(broker_pid);
  if (expected.user_sid != broker.user_sid || expected.logon_sid != broker.logon_sid ||
      !same_luid(expected.authentication_id, broker.authentication_id) ||
      expected.integrity_rid != broker.integrity_rid) {
    std::fprintf(stderr, "crosshands-pipe-relay: broker identity mismatch\n");
    return 3;
  }
  DWORD expected_windows_session = 0;
  if (!ProcessIdToSessionId(broker_pid, &expected_windows_session)) fail("broker session failed");

  const std::wstring sddl = L"D:P(A;;GA;;;" + expected.logon_sid + L")";
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1,
                                                             &descriptor, nullptr)) {
    fail("security descriptor creation failed");
  }
  SECURITY_ATTRIBUTES security{sizeof(SECURITY_ATTRIBUTES), descriptor, FALSE};
  std::thread input_thread(stdin_dispatcher);
  send_record(kReady, 0);

  bool first_instance = true;
  while (!g_stopping) {
    const DWORD open_mode = PIPE_ACCESS_DUPLEX | (first_instance ? FILE_FLAG_FIRST_PIPE_INSTANCE : 0);
    HANDLE pipe = CreateNamedPipeW(
        pipe_name.c_str(), open_mode,
        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
        PIPE_UNLIMITED_INSTANCES, 64 * 1024, 64 * 1024, 0, &security);
    first_instance = false;
    if (pipe == INVALID_HANDLE_VALUE) {
      g_stopping = true;
      break;
    }
    const BOOL connected = ConnectNamedPipe(pipe, nullptr)
                               ? TRUE
                               : (GetLastError() == ERROR_PIPE_CONNECTED ? TRUE : FALSE);
    if (!connected) {
      CloseHandle(pipe);
      continue;
    }
    if (g_stopping) {
      DisconnectNamedPipe(pipe);
      CloseHandle(pipe);
      break;
    }
    PeerIdentity peer;
    if (!inspect_peer(pipe, expected, expected_windows_session, &peer)) {
      DisconnectNamedPipe(pipe);
      CloseHandle(pipe);
      continue;
    }
    const std::uint64_t id = g_next_connection.fetch_add(1);
    {
      std::lock_guard<std::mutex> lock(g_clients_mutex);
      g_clients.emplace(id, pipe);
    }
    const std::string metadata = peer_json(peer);
    send_record(kOpen, id, metadata.data(), static_cast<std::uint32_t>(metadata.size()));
    std::thread(client_reader, id, pipe).detach();
  }

  g_stopping = true;
  if (input_thread.joinable()) input_thread.join();
  LocalFree(descriptor);
  return 0;
}
