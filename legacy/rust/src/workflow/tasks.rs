use std::{future::Future, sync::Arc};

use tokio_util::task::TaskTracker;
use workflow_resources::{ResourceStore, with_resources};

pub(super) struct WorkflowTasks {
    resources: Arc<ResourceStore>,
    tasks: TaskTracker,
}

impl WorkflowTasks {
    pub(super) fn new(resources: Arc<ResourceStore>) -> Self {
        Self {
            resources,
            tasks: TaskTracker::new(),
        }
    }

    pub(super) fn spawn<F>(&self, future: F)
    where
        F: Future<Output = ()> + Send + 'static,
    {
        let resources = Arc::clone(&self.resources);
        self.tasks.spawn(with_resources(resources, future));
    }

    #[cfg(test)]
    fn tracked_count(&self) -> usize {
        self.tasks.len()
    }
}

impl std::fmt::Debug for WorkflowTasks {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("WorkflowTasks")
            .field("tracked_tasks", &self.tasks.len())
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use tokio::sync::oneshot;
    use workflow_resources::{ResourceStore, current_resources};

    use super::WorkflowTasks;

    #[tokio::test]
    async fn spawned_driver_receives_resources_and_is_removed_after_completion() {
        let resources = Arc::new(ResourceStore::new());
        let tasks = WorkflowTasks::new(Arc::clone(&resources));
        let (observed_sender, observed_receiver) = oneshot::channel();
        let (release_sender, release_receiver) = oneshot::channel();

        tasks.spawn(async move {
            let observed =
                current_resources().is_ok_and(|current| Arc::ptr_eq(&current, &resources));
            let _ = observed_sender.send(observed);
            let _ = release_receiver.await;
        });

        assert_eq!(observed_receiver.await, Ok(true));
        assert_eq!(tasks.tracked_count(), 1);
        let _ = release_sender.send(());
        tokio::task::yield_now().await;
        tokio::task::yield_now().await;
        assert_eq!(tasks.tracked_count(), 0);
    }
}
