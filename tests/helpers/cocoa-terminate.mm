#import <Cocoa/Cocoa.h>
#include <node_api.h>
// Test-only helper: exercise the Cocoa termination route used by Sparkle.
static napi_value Terminate(napi_env env, napi_callback_info info) {
    dispatch_async(dispatch_get_main_queue(), ^{ [NSApp terminate:nil]; });
    napi_value value; napi_get_undefined(env, &value); return value;
}
static napi_value Init(napi_env env, napi_value exports) {
    napi_value function; napi_create_function(env, "terminate", NAPI_AUTO_LENGTH, Terminate, nullptr, &function);
    napi_set_named_property(env, exports, "terminate", function); return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
