#import <Cocoa/Cocoa.h>
#import <Sparkle/Sparkle.h>
#include <node_api.h>

// All entry points run on Electron's Cocoa main thread. No synchronous call
// from Cocoa back into JS: use an unreferenced Node-API threadsafe function.
static SPUStandardUpdaterController *controller;
static napi_threadsafe_function installCallback;
static BOOL busy = NO;
static BOOL preparing = NO;
static void (^pendingInstall)(void);

@interface TridentUpdaterDelegate : NSObject <SPUUpdaterDelegate>
@end
static TridentUpdaterDelegate *delegate;
@implementation TridentUpdaterDelegate
- (BOOL)updater:(SPUUpdater *)updater mayPerformUpdateCheck:(SPUUpdateCheck)check error:(NSError **)error {
    if (!busy && !preparing) return YES;
    if (error) *error = [NSError errorWithDomain:@"com.trident.updater" code:1 userInfo:@{NSLocalizedDescriptionKey: @"请先断开连接并等待文件操作完成，再检查更新。"}];
    return NO;
}
- (BOOL)updater:(SPUUpdater *)updater shouldPostponeRelaunchForUpdate:(SUAppcastItem *)item untilInvokingBlock:(void (^)(void))handler {
    preparing = YES;
    pendingInstall = [handler copy];
    if (installCallback) napi_call_threadsafe_function(installCallback, (void *)"prepare-install", napi_tsfn_nonblocking);
    return YES;
}
- (void)updater:(SPUUpdater *)updater didAbortWithError:(NSError *)error {
    if (preparing || pendingInstall) {
        preparing = NO;
        pendingInstall = nil;
        if (installCallback) napi_call_threadsafe_function(installCallback, (void *)"cancel-install", napi_tsfn_nonblocking);
    }
}
@end

static napi_value Undefined(napi_env env) { napi_value v; napi_get_undefined(env, &v); return v; }
static bool MainThread(napi_env env) {
    if ([NSThread isMainThread]) return true;
    napi_throw_error(env, nullptr, "Sparkle must run on the Cocoa main thread");
    return false;
}
static void CallInstall(napi_env env, napi_value callback, void *, void *data) {
    if (!env || !callback) return;
    napi_value result, event;
    napi_create_string_utf8(env, (const char *)data, NAPI_AUTO_LENGTH, &event);
    napi_call_function(env, Undefined(env), callback, 1, &event, &result);
}
static void Cleanup(void *) {
    pendingInstall = nil;
    if (installCallback) {
        napi_release_threadsafe_function(installCallback, napi_tsfn_abort);
        installCallback = nullptr;
    }
}
static napi_value Start(napi_env env, napi_callback_info info) {
    if (!MainThread(env)) return nullptr;
    if (controller) return Undefined(env);
    size_t argc = 1; napi_value args[1];
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    napi_valuetype type;
    if (argc != 1 || napi_typeof(env, args[0], &type) != napi_ok || type != napi_function) {
        napi_throw_type_error(env, nullptr, "Expected install callback"); return nullptr;
    }
    napi_value name; napi_create_string_utf8(env, "TridentSparkleInstall", NAPI_AUTO_LENGTH, &name);
    if (napi_create_threadsafe_function(env, args[0], nullptr, name, 0, 1, nullptr, nullptr, nullptr, CallInstall, &installCallback) != napi_ok) {
        napi_throw_error(env, nullptr, "Cannot create install callback"); return nullptr;
    }
    napi_unref_threadsafe_function(env, installCallback);
    napi_add_env_cleanup_hook(env, Cleanup, nullptr);
    delegate = [TridentUpdaterDelegate new];
    controller = [[SPUStandardUpdaterController alloc] initWithStartingUpdater:NO updaterDelegate:delegate userDriverDelegate:nil];
    NSError *error = nil;
    if (![controller.updater startUpdater:&error]) {
        controller = nil;
        napi_throw_error(env, nullptr, error.localizedDescription.UTF8String); return nullptr;
    }
    controller.updater.automaticallyDownloadsUpdates = NO;
    return Undefined(env);
}
static napi_value State(napi_env env, napi_callback_info) {
    if (!MainThread(env)) return nullptr;
    napi_value result; napi_create_object(env, &result);
    auto set = [&](const char *key, bool value) { napi_value v; napi_get_boolean(env, value, &v); napi_set_named_property(env, result, key, v); };
    set("canCheck", controller && controller.updater.canCheckForUpdates && !busy && !preparing);
    set("inProgress", preparing || (controller && controller.updater.sessionInProgress));
    set("automatic", controller && controller.updater.automaticallyChecksForUpdates);
    set("pendingInstall", pendingInstall != nil);
    return result;
}
static napi_value Check(napi_env env, napi_callback_info) {
    if (!MainThread(env)) return nullptr;
    if (!controller || busy || preparing || !controller.updater.canCheckForUpdates) {
        napi_throw_error(env, nullptr, "请先断开连接，或等待当前更新检查结束。"); return nullptr;
    }
    [controller checkForUpdates:nil];
    return Undefined(env);
}
static bool BooleanArg(napi_env env, napi_callback_info info, bool *value) {
    size_t argc = 1; napi_value args[1]; napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    if (argc == 1 && napi_get_value_bool(env, args[0], value) == napi_ok) return true;
    napi_throw_type_error(env, nullptr, "Expected boolean"); return false;
}
static napi_value SetBusy(napi_env env, napi_callback_info info) {
    if (!MainThread(env)) return nullptr;
    bool value; if (!BooleanArg(env, info, &value)) return nullptr;
    busy = value; return Undefined(env);
}
static napi_value SetAutomatic(napi_env env, napi_callback_info info) {
    if (!MainThread(env)) return nullptr;
    bool value; if (!BooleanArg(env, info, &value)) return nullptr;
    controller.updater.automaticallyChecksForUpdates = value;
    return Undefined(env);
}
static napi_value Resume(napi_env env, napi_callback_info) {
    if (!MainThread(env)) return nullptr;
    if (pendingInstall && !busy) {
        void (^handler)(void) = pendingInstall;
        pendingInstall = nil;
        // Leave preparing set: no new work between saving state and termination.
        handler();
    }
    return Undefined(env);
}
static napi_value Init(napi_env env, napi_value exports) {
    const napi_property_descriptor properties[] = {
        {"start", nullptr, Start, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"state", nullptr, State, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"check", nullptr, Check, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"setBusy", nullptr, SetBusy, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"setAutomatic", nullptr, SetAutomatic, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"resume", nullptr, Resume, nullptr, nullptr, nullptr, napi_default, nullptr},
    };
    napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
    return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
