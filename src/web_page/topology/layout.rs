pub(super) fn node_transform(id: &str) -> &'static str {
    match id {
        "prepare" => "translate(20 123)",
        "choose_route" => "translate(170 123)",
        "yes_path" => "translate(330 42)",
        "fallback_path" => "translate(330 204)",
        "converge" => "translate(490 123)",
        "complete" => "translate(640 123)",
        "receive" => "translate(50 123)",
        "inspect" => "translate(230 123)",
        "approve" => "translate(410 123)",
        "archive" => "translate(590 123)",
        _ => "translate(0 0)",
    }
}

pub(super) fn edge_path(id: &str) -> &'static str {
    match id {
        "prepare-to-choose" => "M 140 150 L 170 150",
        "choose-to-yes" => "M 290 144 C 305 144 305 69 330 69",
        "choose-to-fallback" => "M 290 156 C 305 156 305 231 330 231",
        "yes-to-converge" => "M 450 69 C 475 69 475 144 490 144",
        "fallback-to-converge" => "M 450 231 C 475 231 475 156 490 156",
        "converge-to-complete" => "M 610 150 L 640 150",
        "receive-to-inspect" => "M 170 150 L 230 150",
        "inspect-to-approve" => "M 350 150 L 410 150",
        "approve-to-archive" => "M 530 150 L 590 150",
        _ => "M 0 0",
    }
}

pub(super) fn edge_label_x(id: &str) -> &'static str {
    match id {
        "prepare-to-choose" => "142",
        "choose-to-yes" | "choose-to-fallback" => "294",
        "yes-to-converge" | "fallback-to-converge" => "452",
        "converge-to-complete" => "612",
        "receive-to-inspect" => "180",
        "inspect-to-approve" => "360",
        "approve-to-archive" => "540",
        _ => "0",
    }
}

pub(super) fn edge_label_y(id: &str) -> &'static str {
    match id {
        "choose-to-yes" | "yes-to-converge" => "94",
        "choose-to-fallback" | "fallback-to-converge" => "218",
        "prepare-to-choose"
        | "converge-to-complete"
        | "receive-to-inspect"
        | "inspect-to-approve"
        | "approve-to-archive" => "173",
        _ => "0",
    }
}
