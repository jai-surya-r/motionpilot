/*
 * Minimal CSInterface shim for CEP panels.
 * Covers what this extension needs: evalScript + extension path.
 * (Adobe's full CSInterface.js is not required for these calls.)
 */
function CSInterface() {}

CSInterface.EVAL_SCRIPT_ERROR = "EvalScript error.";

/* Path-type constants for getSystemPath (same values as Adobe's CSInterface.js). */
var SystemPath = {
    USER_DATA: "userData",
    COMMON_FILES: "commonFiles",
    MY_DOCUMENTS: "myDocuments",
    APPLICATION: "application",
    EXTENSION: "extension",
    HOST_APPLICATION: "hostApplication"
};

CSInterface.prototype.evalScript = function (script, callback) {
    callback = callback || function () {};
    if (window.__adobe_cep__ && window.__adobe_cep__.evalScript) {
        window.__adobe_cep__.evalScript(script, callback);
    } else {
        callback(CSInterface.EVAL_SCRIPT_ERROR);
    }
};

CSInterface.prototype.getSystemPath = function (pathType) {
    if (window.__adobe_cep__ && window.__adobe_cep__.getSystemPath) {
        var p = decodeURI(window.__adobe_cep__.getSystemPath(pathType));
        return p.replace("file:///", "").replace("file://", "");
    }
    return "";
};
