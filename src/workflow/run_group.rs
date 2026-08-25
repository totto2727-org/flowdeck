use std::{num::NonZeroUsize, sync::Arc};

use tokio::sync::{OwnedSemaphorePermit, Semaphore};

#[derive(Clone)]
pub(super) struct ActiveRunGroup {
    semaphore: Arc<Semaphore>,
    limit: usize,
}

pub(super) struct ActiveRunGuard {
    _permit: OwnedSemaphorePermit,
}

#[derive(Debug)]
pub(super) struct ActiveRunLimitReached {
    pub(super) limit: usize,
}

impl ActiveRunGroup {
    pub(super) fn new(limit: NonZeroUsize) -> Self {
        Self {
            semaphore: Arc::new(Semaphore::new(limit.get())),
            limit: limit.get(),
        }
    }

    pub(super) fn try_join(&self) -> Result<ActiveRunGuard, ActiveRunLimitReached> {
        Arc::clone(&self.semaphore)
            .try_acquire_owned()
            .map(|permit| ActiveRunGuard { _permit: permit })
            .map_err(|_| ActiveRunLimitReached { limit: self.limit })
    }
}

#[cfg(test)]
mod tests {
    use std::num::NonZeroUsize;

    use super::ActiveRunGroup;

    #[test]
    fn dropping_a_run_guard_releases_the_group_slot() {
        let group = ActiveRunGroup::new(NonZeroUsize::MIN);
        let guard = group
            .try_join()
            .expect("the first run should join the group");

        assert!(group.try_join().is_err());
        drop(guard);
        assert!(group.try_join().is_ok());
    }
}
