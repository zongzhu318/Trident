#import <Cocoa/Cocoa.h>
#import <Sparkle/Sparkle.h>
#include <node_api.h>

// All entry points run on Electron's Cocoa main thread. No synchronous call
// from Cocoa back into JS: use an unreferenced Node-API threadsafe function.
static SPUUpdater *updater;
static SPUStandardUserDriver *userDriver;
static napi_threadsafe_function installCallback;
static BOOL busy = NO;
static BOOL preparing = NO;
// Sparkle 只在用户选择「安装并重启」时才把会话交给我们确认。必须在这一刻
// 保存其 reply，取消时回复 SKIP 才能真正结束会话；dismissUpdateInstallation
// 只拆除界面，会让会话永久停留在等待 relaunch 的状态。
static void (^pendingReply)(SPUUserUpdateChoice);

static void Notify(NSString *event) {
    if (installCallback) napi_call_threadsafe_function(installCallback, (void *)event.UTF8String, napi_tsfn_nonblocking);
}

// 进入安装确认阶段：先不回复 Sparkle，等 JS 侧落盘并断开连接后再决定。
static void PrepareInstall(void (^reply)(SPUUserUpdateChoice)) {
    pendingReply = [reply copy];
    preparing = YES;
    Notify(@"prepare-install");
}

// Sparkle 在会话结束时可能回调 didAbortWithError（有错误）或
// standardUserDriverWillFinishUpdateSession（无错误）；两者都会清掉待回复。
static void CancelPending(void) {
    if (pendingReply == nil && !preparing) return;
    pendingReply = nil;
    preparing = NO;
    Notify(@"cancel-install");
}

@interface TridentUserDriverDelegate : NSObject <SPUUpdaterDelegate, SPUStandardUserDriverDelegate>
@end

@implementation TridentUserDriverDelegate
- (BOOL)updater:(SPUUpdater *)theUpdater mayPerformUpdateCheck:(SPUUpdateCheck)check error:(NSError **)error {
    if (!busy && !preparing) return YES;
    if (error) *error = [NSError errorWithDomain:@"com.trident.updater" code:1 userInfo:@{NSLocalizedDescriptionKey: @"请先断开连接并等待文件操作完成，再检查更新。"}];
    return NO;
}
- (void)updater:(SPUUpdater *)theUpdater didAbortWithError:(NSError *)error {
    CancelPending();
}
- (void)standardUserDriverWillFinishUpdateSession {
    CancelPending();
}
@end

// 安装候选只出现在两处：已下载更新直接询问「安装并重启」，以及更新已在
// 后台开始安装时的更新说明。两处都拦截 INSTALL，改由应用先确认能否退出。
@interface TridentUserDriver : SPUStandardUserDriver
@end

@implementation TridentUserDriver
- (void)showUpdateFoundWithAppcastItem:(SUAppcastItem *)item state:(SPUUserUpdateState *)state reply:(void (^)(SPUUserUpdateChoice))reply {
    if (state.stage != SPUUserUpdateStageInstalling) {
        [super showUpdateFoundWithAppcastItem:item state:state reply:reply];
        return;
    }
    [super showUpdateFoundWithAppcastItem:item state:state reply:^(SPUUserUpdateChoice choice) {
        if (choice != SPUUserUpdateChoiceInstall) return reply(choice);
        PrepareInstall(reply);
    }];
}
- (void)showReadyToInstallAndRelaunch:(void (^)(SPUUserUpdateChoice))installUpdateHandler {
    [super showReadyToInstallAndRelaunch:^(SPUUserUpdateChoice choice) {
        if (choice != SPUUserUpdateChoiceInstall) return installUpdateHandler(choice);
        PrepareInstall(installUpdateHandler);
    }];
}
@end

static TridentUserDriverDelegate *driverDelegate;

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
    pendingReply = nil;
    if (installCallback) {
        napi_release_threadsafe_function(installCallback, napi_tsfn_abort);
        installCallback = nullptr;
    }
}
static napi_value Start(napi_env env, napi_callback_info info) {
    if (!MainThread(env)) return nullptr;
    if (updater) return Undefined(env);
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
    driverDelegate = [TridentUserDriverDelegate new];
    NSBundle *host = [NSBundle mainBundle];
    userDriver = [[TridentUserDriver alloc] initWithHostBundle:host delegate:driverDelegate];
    updater = [[SPUUpdater alloc] initWithHostBundle:host applicationBundle:host userDriver:userDriver delegate:driverDelegate];
    NSError *error = nil;
    if (![updater startUpdater:&error]) {
        updater = nil;
        userDriver = nil;
        napi_throw_error(env, nullptr, error.localizedDescription.UTF8String); return nullptr;
    }
    updater.automaticallyDownloadsUpdates = NO;
    // Sparkle 默认按 updateCheckInterval（约一天）调度；开启自动检查时再在启动后
    // 立即后台检查一次，否则用户可能连续多次启动都收不到新版本提示。
    if (updater.automaticallyChecksForUpdates) {
        [updater checkForUpdatesInBackground];
    }
    return Undefined(env);
}
static napi_value State(napi_env env, napi_callback_info) {
    if (!MainThread(env)) return nullptr;
    napi_value result; napi_create_object(env, &result);
    auto set = [&](const char *key, bool value) { napi_value v; napi_get_boolean(env, value, &v); napi_set_named_property(env, result, key, v); };
    set("canCheck", updater && updater.canCheckForUpdates && !busy && !preparing);
    // sessionInProgress 覆盖检查与下载；preparing 覆盖等待用户答复到进程替换。
    // 两者仅用于可观测性与菜单判断，连接闸门由 JS 侧退出协调器负责。
    set("checking", !preparing && updater && updater.sessionInProgress);
    set("installing", preparing);
    set("automatic", updater && updater.automaticallyChecksForUpdates);
    set("pendingInstall", pendingReply != nil);
    return result;
}
static napi_value Check(napi_env env, napi_callback_info) {
    if (!MainThread(env)) return nullptr;
    if (!updater || busy || preparing || !updater.canCheckForUpdates) {
        napi_throw_error(env, nullptr, "请先断开连接，或等待当前更新检查结束。"); return nullptr;
    }
    [updater checkForUpdates];
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
    updater.automaticallyChecksForUpdates = value;
    return Undefined(env);
}
static napi_value Resume(napi_env env, napi_callback_info) {
    if (!MainThread(env)) return nullptr;
    if (pendingReply && !busy) {
        void (^reply)(SPUUserUpdateChoice) = pendingReply;
        pendingReply = nil;
        // Leave preparing set: no new work between saving state and termination.
        reply(SPUUserUpdateChoiceInstall);
    }
    return Undefined(env);
}
static napi_value CancelInstall(napi_env env, napi_callback_info) {
    if (!MainThread(env)) return nullptr;
    void (^reply)(SPUUserUpdateChoice) = pendingReply;
    pendingReply = nil;
    // 先复位状态，Sparkle 随后的会话结束回调便不会重复通知 JS。
    preparing = NO;
    // SKIP 取消本次已准备安装的更新但不跳过该版本，Sparkle 会据此结束会话；
    // 会话结束后再次检查更新会重新呈现这个已下载的版本。
    if (reply) reply(SPUUserUpdateChoiceSkip);
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
        {"cancelInstall", nullptr, CancelInstall, nullptr, nullptr, nullptr, napi_default, nullptr},
    };
    napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
    return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
