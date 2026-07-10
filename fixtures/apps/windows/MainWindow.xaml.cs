using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;

namespace CrossHands.ConformanceFixture;

public partial class MainWindow : Window
{
    private readonly string oraclePath;
    private readonly string instance;
    private int renderEpoch = 1;
    private int invokeCount;
    private int secondaryCount;
    private string focusedControl = "none";
    private string dragRegion = "origin";

    public MainWindow()
    {
        InitializeComponent();
        var args = Environment.GetCommandLineArgs();
        oraclePath = Argument(args, "--oracle", Path.Combine(Path.GetTempPath(), "crosshands-fixture-oracle.json"));
        instance = Argument(args, "--instance", "a");
        Title = $"CrossHands Fixture — Duplicate — {instance}";
        Loaded += (_, _) => WriteOracle();
    }

    private static string Argument(string[] args, string name, string fallback)
    {
        var index = Array.IndexOf(args, name);
        return index >= 0 && index + 1 < args.Length ? Path.GetFullPath(args[index + 1]) : fallback;
    }

    private void Invoke(object sender, RoutedEventArgs e) { invokeCount++; focusedControl = "invoke"; WriteOracle(); }
    private void Changed(object sender, RoutedEventArgs e) => WriteOracle();
    private void Changed(object sender, TextChangedEventArgs e) => WriteOracle();
    private void Changed(object sender, SelectionChangedEventArgs e) => WriteOracle();
    private void Changed(object sender, RoutedPropertyChangedEventArgs<double> e) => WriteOracle();
    private void Focused(object sender, RoutedEventArgs e) { focusedControl = sender is PasswordBox ? "secure-text" : "ordinary-text"; WriteOracle(); }
    private void Rerender(object sender, RoutedEventArgs e) { renderEpoch++; Title = $"CrossHands Fixture — Duplicate — {instance} — epoch {renderEpoch}"; WriteOracle(); }
    private void DragCompleted(object sender, RoutedEventArgs e) { dragRegion = "target"; WriteOracle(); }
    private void Secondary(object sender, RoutedEventArgs e) { secondaryCount++; WriteOracle(); }

    private void WriteOracle()
    {
        if (!IsLoaded) return;
        var textDigest = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(OrdinaryText.Text))).ToLowerInvariant();
        var state = new {
            schemaVersion = "crosshands.fixture-oracle/v1",
            fixtureVersion = "1.0.0",
            instance,
            renderEpoch,
            invokeCount,
            toggle = Toggle.IsChecked == true,
            selection = ((ComboBoxItem?)Selection.SelectedItem)?.Content?.ToString() ?? "alpha",
            focusedControl,
            ordinaryTextDigest = $"sha256:{textDigest}",
            keyCount = 0,
            hotkeyCount = 0,
            scrollOffset = (int)ScrollOffset.Value,
            dragRegion,
            secondaryActionCount = secondaryCount
        };
        Directory.CreateDirectory(Path.GetDirectoryName(oraclePath)!);
        var temporary = $"{oraclePath}.{Guid.NewGuid():N}.tmp";
        File.WriteAllText(temporary, JsonSerializer.Serialize(state));
        File.Move(temporary, oraclePath, true);
    }
}
