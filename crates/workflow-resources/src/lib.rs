//! Provider-neutral storage and propagation for live workflow resources.

use std::{
    any::{Any, TypeId},
    collections::HashMap,
    future::Future,
    sync::{Arc, Mutex},
};

/// Lifetime domain for one live resource.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub enum ResourceScope {
    /// Resource shared by every execution in one application instance.
    Application,
    /// Resource owned by one workflow run.
    Run(String),
    /// Resource owned by one provider session that may span workflow runs.
    Session(String),
}

/// Domain identity for a live resource.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ResourceKey {
    /// Lifetime domain that owns the resource.
    pub scope: ResourceScope,
    /// Stable name within the scope and Rust resource type.
    pub name: String,
}

impl ResourceKey {
    /// Construct a key from an explicit scope and stable name.
    #[must_use]
    pub fn new(scope: ResourceScope, name: impl Into<String>) -> Self {
        Self {
            scope,
            name: name.into(),
        }
    }

    /// Construct an application-scoped key.
    #[must_use]
    pub fn application(name: impl Into<String>) -> Self {
        Self::new(ResourceScope::Application, name)
    }

    /// Construct a run-scoped key.
    #[must_use]
    pub fn run(run_id: impl Into<String>, name: impl Into<String>) -> Self {
        Self::new(ResourceScope::Run(run_id.into()), name)
    }

    /// Construct a session-scoped key.
    #[must_use]
    pub fn session(session_id: impl Into<String>, name: impl Into<String>) -> Self {
        Self::new(ResourceScope::Session(session_id.into()), name)
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct TypedResourceKey {
    key: ResourceKey,
    resource_type: TypeId,
}

impl TypedResourceKey {
    const fn new<T>(key: ResourceKey) -> Self
    where
        T: Send + Sync + 'static,
    {
        Self {
            key,
            resource_type: TypeId::of::<T>(),
        }
    }
}

type SharedResource = Arc<dyn Any + Send + Sync>;

#[derive(Debug, Default)]
struct ResourceEntry {
    value: Mutex<Option<SharedResource>>,
}

/// Typed heterogeneous store for non-serializable workflow resources.
#[derive(Debug, Default)]
pub struct ResourceStore {
    entries: Mutex<HashMap<TypedResourceKey, Arc<ResourceEntry>>>,
}

impl ResourceStore {
    /// Create an empty store.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Clone a typed resource when the key has been initialized.
    #[must_use]
    pub fn get<T>(&self, key: &ResourceKey) -> Option<Arc<T>>
    where
        T: Send + Sync + 'static,
    {
        let typed_key = TypedResourceKey::new::<T>(key.clone());
        let entry = self
            .entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(&typed_key)
            .cloned()?;
        let resource = entry
            .value
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()?;
        Arc::downcast(resource).ok()
    }

    /// Return one typed resource, initializing it once for concurrent callers.
    ///
    /// Initialization for unrelated keys proceeds concurrently. A failed initializer leaves the
    /// key empty so a later caller can retry.
    ///
    /// # Errors
    /// Returns the initializer error when the resource cannot be created.
    pub fn get_or_try_init<T, E>(
        &self,
        key: ResourceKey,
        initialize: impl FnOnce() -> Result<T, E>,
    ) -> Result<Arc<T>, E>
    where
        T: Send + Sync + 'static,
    {
        let typed_key = TypedResourceKey::new::<T>(key);
        let entry = {
            let mut entries = self
                .entries
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            Arc::clone(entries.entry(typed_key).or_default())
        };
        let mut value = entry
            .value
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(resource) = value.as_ref()
            && let Ok(resource) = Arc::downcast(Arc::clone(resource))
        {
            return Ok(resource);
        }
        let resource = Arc::new(initialize()?);
        *value = Some(resource.clone());
        drop(value);
        Ok(resource)
    }

    /// Remove every stored value owned by a scope.
    ///
    /// Existing `Arc` borrowers keep their values alive until they release them.
    /// The scope owner must quiesce initialization for the scope before removing it.
    pub fn remove_scope(&self, scope: &ResourceScope) {
        self.entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .retain(|key, _| &key.key.scope != scope);
    }
}

tokio::task_local! {
    static CURRENT_RESOURCES: Arc<ResourceStore>;
}

/// Run a future with an execution-scoped resource store.
pub async fn with_resources<T>(
    resources: Arc<ResourceStore>,
    future: impl Future<Output = T>,
) -> T {
    CURRENT_RESOURCES.scope(resources, future).await
}

/// Failure to resolve the resource store for the current execution.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum ResourceError {
    /// The caller is not running inside a workflow resource scope.
    #[error("workflow resources were accessed outside an execution scope")]
    OutsideExecutionScope,
}

/// Resolve the store attached to the current asynchronous execution chain.
///
/// # Errors
/// Returns [`ResourceError::OutsideExecutionScope`] when no store is attached to the current
/// Tokio task.
pub fn current_resources() -> Result<Arc<ResourceStore>, ResourceError> {
    CURRENT_RESOURCES
        .try_with(Arc::clone)
        .map_err(|_| ResourceError::OutsideExecutionScope)
}

#[cfg(test)]
mod tests {
    use std::{
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
        thread,
    };

    use super::{
        ResourceError, ResourceKey, ResourceScope, ResourceStore, current_resources, with_resources,
    };

    #[test]
    fn same_domain_key_keeps_resource_types_independent() {
        let store = ResourceStore::new();
        let key = ResourceKey::application("shared-name");

        let number = store
            .get_or_try_init(key.clone(), || Ok::<_, ()>(41_u64))
            .unwrap_or_else(|()| unreachable!());
        let text = store
            .get_or_try_init(key.clone(), || Ok::<_, ()>(String::from("resource")))
            .unwrap_or_else(|()| unreachable!());

        assert_eq!(*number, 41);
        assert_eq!(text.as_str(), "resource");
        assert_eq!(store.get::<u64>(&key).as_deref(), Some(&41));
        assert_eq!(
            store.get::<String>(&key).as_deref(),
            Some(&String::from("resource"))
        );
    }

    #[test]
    fn failed_initialization_can_be_retried() {
        let store = ResourceStore::new();
        let key = ResourceKey::application("retryable");

        let failure = store.get_or_try_init::<u64, _>(key.clone(), || Err("not ready"));
        let resource = store
            .get_or_try_init(key, || Ok::<_, &str>(42_u64))
            .unwrap_or_else(|error| unreachable!("unexpected error: {error}"));

        assert_eq!(failure, Err("not ready"));
        assert_eq!(*resource, 42);
    }

    #[test]
    fn concurrent_first_use_publishes_one_resource() {
        let store = Arc::new(ResourceStore::new());
        let initializations = Arc::new(AtomicUsize::new(0));
        let resources = (0..8)
            .map(|_| {
                let store = Arc::clone(&store);
                let initializations = Arc::clone(&initializations);
                thread::spawn(move || {
                    store
                        .get_or_try_init(ResourceKey::application("runtime"), || {
                            initializations.fetch_add(1, Ordering::SeqCst);
                            Ok::<_, ()>(String::from("runtime"))
                        })
                        .unwrap_or_else(|()| unreachable!())
                })
            })
            .map(|handle| handle.join().unwrap_or_else(|_| unreachable!()))
            .collect::<Vec<_>>();

        assert_eq!(initializations.load(Ordering::SeqCst), 1);
        assert!(
            resources
                .windows(2)
                .all(|pair| Arc::ptr_eq(&pair[0], &pair[1]))
        );
    }

    #[test]
    fn removing_scope_preserves_outstanding_borrowers() {
        let store = ResourceStore::new();
        let scope = ResourceScope::Run(String::from("run-1"));
        let key = ResourceKey::new(scope.clone(), "subscription");
        let resource = store
            .get_or_try_init(key.clone(), || Ok::<_, ()>(String::from("live")))
            .unwrap_or_else(|()| unreachable!());

        store.remove_scope(&scope);

        assert_eq!(resource.as_str(), "live");
        assert!(store.get::<String>(&key).is_none());
    }

    #[tokio::test]
    async fn access_outside_execution_returns_typed_error() {
        assert!(matches!(
            current_resources(),
            Err(ResourceError::OutsideExecutionScope)
        ));
    }

    #[tokio::test]
    async fn nested_scope_restores_outer_store() {
        let outer = Arc::new(ResourceStore::new());
        let inner = Arc::new(ResourceStore::new());

        with_resources(Arc::clone(&outer), async {
            assert!(Arc::ptr_eq(
                &current_resources().unwrap_or_else(|error| unreachable!("{error}")),
                &outer
            ));
            with_resources(Arc::clone(&inner), async {
                assert!(Arc::ptr_eq(
                    &current_resources().unwrap_or_else(|error| unreachable!("{error}")),
                    &inner
                ));
            })
            .await;
            assert!(Arc::ptr_eq(
                &current_resources().unwrap_or_else(|error| unreachable!("{error}")),
                &outer
            ));
        })
        .await;
    }

    #[tokio::test]
    async fn concurrent_scopes_do_not_leak_run_resources() {
        async fn observe(run_id: &str) -> String {
            tokio::task::yield_now().await;
            let resources = current_resources().unwrap_or_else(|error| unreachable!("{error}"));
            let key = ResourceKey::run(run_id, "value");
            resources
                .get_or_try_init(key, || Ok::<_, ()>(run_id.to_owned()))
                .unwrap_or_else(|()| unreachable!())
                .as_str()
                .to_owned()
        }

        let resources = Arc::new(ResourceStore::new());
        let first = with_resources(Arc::clone(&resources), observe("run-1"));
        let second = with_resources(resources, observe("run-2"));
        let (first, second) = tokio::join!(first, second);

        assert_eq!(first, "run-1");
        assert_eq!(second, "run-2");
    }

    #[test]
    fn graph_session_serialization_excludes_live_resources() {
        #[derive(Debug)]
        struct NonSerializableResource;

        let store = ResourceStore::new();
        let key = ResourceKey::application("non-serializable-sentinel");
        let _resource = store
            .get_or_try_init(key, || Ok::<_, ()>(NonSerializableResource))
            .unwrap_or_else(|()| unreachable!());
        let session = graph_flow::Session::new_from_task(String::from("session-1"), "start");

        let serialized = serde_json::to_value(&session)
            .unwrap_or_else(|error| unreachable!("session serialization failed: {error}"));
        let restored = serde_json::from_value::<graph_flow::Session>(serialized.clone())
            .unwrap_or_else(|error| unreachable!("session deserialization failed: {error}"));

        assert_eq!(restored.id, "session-1");
        assert!(!serialized.to_string().contains("non-serializable-sentinel"));
    }
}
