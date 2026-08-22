use std::collections::{HashMap, HashSet, VecDeque};

use workflow_console_experiment::WorkflowDefinition;

const NODE_WIDTH: i32 = 120;
const NODE_HEIGHT: i32 = 54;
const HORIZONTAL_GAP: i32 = 60;
const VERTICAL_GAP: i32 = 54;
const PADDING_X: i32 = 30;
const PADDING_TOP: i32 = 80;
const PADDING_BOTTOM: i32 = 30;
const LOOP_HEIGHT: i32 = 50;

pub(super) trait TopologyLayoutEngine: Send + Sync {
    fn layout(&self, definition: &'static WorkflowDefinition) -> TopologyLayout;
}

#[derive(Clone, Copy, Debug, Default)]
pub(super) struct LayeredAutoLayout;

#[derive(Clone, Debug)]
pub(super) struct TopologyLayout {
    nodes: HashMap<&'static str, NodeGeometry>,
    edges: HashMap<&'static str, EdgeGeometry>,
    pub(super) view_box: ViewBox,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct NodeGeometry {
    pub(super) x: i32,
    pub(super) y: i32,
    pub(super) width: i32,
    pub(super) height: i32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct EdgeGeometry {
    pub(super) path: String,
    pub(super) label_x: i32,
    pub(super) label_y: i32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct ViewBox {
    pub(super) width: i32,
    pub(super) height: i32,
}

impl TopologyLayout {
    pub(super) fn node(&self, id: &str) -> Option<&NodeGeometry> {
        self.nodes.get(id)
    }

    pub(super) fn edge(&self, id: &str) -> Option<&EdgeGeometry> {
        self.edges.get(id)
    }
}

impl TopologyLayoutEngine for LayeredAutoLayout {
    fn layout(&self, definition: &'static WorkflowDefinition) -> TopologyLayout {
        let ranks = node_ranks(definition);
        let mut rank_rows = HashMap::<usize, usize>::new();
        let mut nodes = HashMap::with_capacity(definition.nodes.len());
        for node in definition.nodes {
            let rank = ranks.get(node.id).copied().unwrap_or_default();
            let row = rank_rows.entry(rank).or_default();
            let rank_x = i32::try_from(rank).unwrap_or(i32::MAX);
            let row_y = i32::try_from(*row).unwrap_or(i32::MAX);
            nodes.insert(
                node.id,
                NodeGeometry {
                    x: PADDING_X.saturating_add(
                        rank_x.saturating_mul(NODE_WIDTH.saturating_add(HORIZONTAL_GAP)),
                    ),
                    y: PADDING_TOP.saturating_add(
                        row_y.saturating_mul(NODE_HEIGHT.saturating_add(VERTICAL_GAP)),
                    ),
                    width: NODE_WIDTH,
                    height: NODE_HEIGHT,
                },
            );
            *row = row.saturating_add(1);
        }
        let edges = definition
            .edges
            .iter()
            .enumerate()
            .filter_map(|(lane, edge)| {
                let from = nodes.get(edge.from)?;
                let to = nodes.get(edge.to)?;
                Some((edge.id, route_edge(from, to, lane)))
            })
            .collect();
        let width = nodes
            .values()
            .map(|node| node.x.saturating_add(node.width))
            .max()
            .unwrap_or(NODE_WIDTH)
            .saturating_add(PADDING_X);
        let height = nodes
            .values()
            .map(|node| node.y.saturating_add(node.height))
            .max()
            .unwrap_or(NODE_HEIGHT)
            .saturating_add(PADDING_BOTTOM);
        TopologyLayout {
            nodes,
            edges,
            view_box: ViewBox { width, height },
        }
    }
}

fn node_ranks(definition: &WorkflowDefinition) -> HashMap<&'static str, usize> {
    let mut incoming = definition
        .nodes
        .iter()
        .map(|node| (node.id, 0usize))
        .collect::<HashMap<_, _>>();
    let mut outgoing = HashMap::<&str, Vec<&str>>::new();
    for edge in definition.edges.iter().filter(|edge| edge.from != edge.to) {
        if let Some(count) = incoming.get_mut(edge.to) {
            *count = count.saturating_add(1);
        }
        outgoing.entry(edge.from).or_default().push(edge.to);
    }
    let mut queue = definition
        .nodes
        .iter()
        .filter(|node| incoming.get(node.id).copied() == Some(0))
        .map(|node| node.id)
        .collect::<VecDeque<_>>();
    let mut ranks = HashMap::<&'static str, usize>::new();
    let mut processed = HashSet::new();
    while let Some(node_id) = queue.pop_front() {
        processed.insert(node_id);
        let next_rank = ranks
            .get(node_id)
            .copied()
            .unwrap_or_default()
            .saturating_add(1);
        for target in outgoing.get(node_id).into_iter().flatten() {
            ranks
                .entry(*target)
                .and_modify(|rank| *rank = (*rank).max(next_rank))
                .or_insert(next_rank);
            if let Some(count) = incoming.get_mut(target) {
                *count = count.saturating_sub(1);
                if *count == 0 {
                    queue.push_back(target);
                }
            }
        }
    }
    let mut fallback_rank = ranks.values().copied().max().unwrap_or_default();
    for node in definition
        .nodes
        .iter()
        .filter(|node| !processed.contains(node.id))
    {
        fallback_rank = fallback_rank.saturating_add(1);
        ranks.insert(node.id, fallback_rank);
    }
    ranks
}

fn route_edge(from: &NodeGeometry, to: &NodeGeometry, lane: usize) -> EdgeGeometry {
    if from == to {
        let start_x = from.x.saturating_add(from.width.saturating_mul(3) / 4);
        let end_x = from.x.saturating_add(from.width / 4);
        let top = from.y.saturating_sub(LOOP_HEIGHT);
        return EdgeGeometry {
            path: format!(
                "M {start_x} {} C {} {top} {} {top} {end_x} {}",
                from.y,
                from.x.saturating_add(from.width),
                from.x,
                from.y
            ),
            label_x: from.x.saturating_add(from.width / 2),
            label_y: top.saturating_sub(4),
        };
    }
    let start_x = from.x.saturating_add(from.width);
    let start_y = from.y.saturating_add(from.height / 2);
    let end_x = to.x;
    let end_y = to.y.saturating_add(to.height / 2);
    if end_x >= start_x {
        let control_x = start_x.saturating_add(end_x).saturating_div(2);
        return EdgeGeometry {
            path: format!(
                "M {start_x} {start_y} C {control_x} {start_y} {control_x} {end_y} {end_x} {end_y}"
            ),
            label_x: control_x,
            label_y: start_y
                .saturating_add(end_y)
                .saturating_div(2)
                .saturating_sub(8),
        };
    }
    let lane_offset = i32::try_from(lane).unwrap_or(i32::MAX).saturating_mul(12);
    let top = from
        .y
        .min(to.y)
        .saturating_sub(LOOP_HEIGHT.saturating_add(lane_offset));
    EdgeGeometry {
        path: format!(
            "M {} {start_y} C {} {top} {} {top} {} {end_y}",
            from.x,
            from.x.saturating_sub(HORIZONTAL_GAP),
            to.x.saturating_add(to.width).saturating_add(HORIZONTAL_GAP),
            to.x.saturating_add(to.width)
        ),
        label_x: from.x.saturating_add(to.x).saturating_div(2),
        label_y: top.saturating_sub(4),
    }
}

#[cfg(test)]
#[path = "geometry/tests.rs"]
mod auto_layout_tests;
