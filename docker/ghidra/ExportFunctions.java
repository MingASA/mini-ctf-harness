// Export selected functions only after every requested decompilation succeeds.
// @category CTF
import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Function;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashSet;

public class ExportFunctions extends GhidraScript {
    @Override
    public void run() throws Exception {
        String[] args = getScriptArgs();
        if (args.length < 1) throw new IllegalArgumentException("Output path required");
        LinkedHashSet<Function> selected = new LinkedHashSet<>();
        if (args.length == 1) {
            for (Function function : currentProgram.getFunctionManager().getFunctions(true)) {
                if (!function.isExternal()) selected.add(function);
            }
        }
        for (int i = 1; i < args.length; i++) {
            boolean found = false;
            for (Function function : currentProgram.getFunctionManager().getFunctions(true)) {
                if (function.getName().equals(args[i]) || function.getName(true).equals(args[i])) {
                    selected.add(function); found = true;
                }
            }
            if (!found && args[i].matches("(?:0x)?[0-9a-fA-F]+")) {
                Address address = currentProgram.getAddressFactory().getAddress(args[i].replaceFirst("^0x", ""));
                Function function = address == null ? null : getFunctionContaining(address);
                if (function != null) { selected.add(function); found = true; }
            }
            if (!found) throw new IllegalArgumentException("Function not found: " + args[i]);
        }
        if (selected.isEmpty()) throw new IllegalArgumentException("No functions found");
        DecompInterface decompiler = new DecompInterface();
        StringBuilder text = new StringBuilder("/* Ghidra pseudocode; verify critical details against instructions. */\n");
        try {
            if (!decompiler.openProgram(currentProgram)) throw new IllegalStateException(decompiler.getLastMessage());
            for (Function function : selected) {
                monitor.checkCancelled();
                DecompileResults result = decompiler.decompileFunction(function, 0, monitor);
                if (!result.decompileCompleted() || result.getDecompiledFunction() == null)
                    throw new IllegalStateException(function.getName() + ": " + result.getErrorMessage());
                text.append("\n/* ").append(function.getName(true)).append(" @ ")
                    .append(function.getEntryPoint()).append(" */\n")
                    .append(result.getDecompiledFunction().getC());
            }
            Files.writeString(Path.of(args[0]), text.toString(), StandardCharsets.UTF_8);
        } finally { decompiler.dispose(); }
    }
}
